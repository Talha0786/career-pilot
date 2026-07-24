import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { withTestDb, resetTestDb } from './setup.js';
import { createDb, type Db } from '../../src/db/client.js';
import { PostgresBudgetStore } from '../../src/llm/postgres-budget-store.js';
import { TieredCostEstimator } from '../../src/llm/cost-estimator.js';
import { FilePromptStore } from '../../src/prompts/file-prompt-store.js';
import {
  DrizzleProfileRepository, DrizzleJobPostingRepository, DrizzleUserRepository,
  DrizzleDocumentRepository, DrizzleMatchScoreRepository, DrizzleUnitOfWork,
} from '../../src/db/repositories/index.js';
import {
  GuardedLlmPort, makeScoreMatchUseCase, makeTailorDocumentUseCase,
} from '@careerpilot/application';
import type { LlmPort, CompleteRequest, CompleteResponse, LlmError } from '@careerpilot/application';
import {
  CareerProfile, JobPosting, Document, User, Email, PasswordHash, isOk, compileFactList,
} from '@careerpilot/domain';
import type { Result } from '@careerpilot/domain';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../prompts');
const MODEL = 'test-guard-model';

// Tuned so TieredCostEstimator's REAL per-token pricing math produces an
// exact, clean $0.0001 per completion call: (100/1000)*0.0005 (input) +
// (100/1000)*0.0005 (output) = 0.0001 — every stub response below declares
// promptTokens/completionTokens = 100/100, so every dispatched call costs
// EXACTLY this, regardless of which pipeline (score-match or
// tailor-document) made it.
const PRICING_TABLE = { [MODEL]: { inputPer1kUsd: 0.0005, outputPer1kUsd: 0.0005, embedPer1kUsd: 0 } };
const PER_CALL_COST = 0.0001;

/** A stub LlmPort — no network — that always returns a schema-valid response for whichever pipeline's prompt it's given (detected by content, same technique as the fake HTTP servers in apps/worker's integration tests), with FIXED token usage so cost is exactly PER_CALL_COST every time. Counts real dispatches — a call GuardedLlmPort budget-rejects never reaches this, so `dispatchCount` is the ground truth for "how many calls actually happened." */
class CountingStubLlm implements LlmPort {
  public dispatchCount = 0;
  async embed(): Promise<Result<never, LlmError>> { throw new Error('not used'); }
  async complete(req: CompleteRequest): Promise<Result<CompleteResponse, LlmError>> {
    this.dispatchCount += 1;
    const isAudit = req.prompt.includes('adversarial claim auditor');
    const isMatchScore = req.prompt.includes('job-match rubric scorer');
    let text: string;
    if (isAudit) {
      text = JSON.stringify({ claims: [{ text: 'Built the pipeline', factId: 'F1', confidence: 0.9 }] });
    } else if (isMatchScore) {
      text = JSON.stringify({ skills: 0.7, experience: 0.6, seniority: 0.6, domain: 0.5, location: 0.5, overall: 0.6, rationale: 'ok' });
    } else {
      text = JSON.stringify({
        summary: null,
        sections: [{ heading: 'Experience', entries: [{ title: 'X', subtitle: 'Y', dateRange: null, bullets: [{ text: 'Built the pipeline', supportingFactIds: ['F1'] }] }] }],
      });
    }
    return { ok: true, value: { text, model: req.model, promptTokens: 100, completionTokens: 100 } };
  }
}

async function seedUserProfileAndJob(db: Db) {
  const user = User.register({
    email: (() => { const r = Email.create(`budget-m5-${Date.now()}-${Math.random()}@test.com`); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
  });
  await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

  const profiles = new DrizzleProfileRepository(db);
  const profileR = CareerProfile.create({ userId: user.id, title: 'Profile' });
  if (!isOk(profileR)) throw new Error('setup failed');
  const profile = profileR.value;
  const addedR = profile.addSection({
    kind: 'experience',
    content: { schemaVersion: 1, title: 'Engineer', organization: 'Acme', startDate: '2021-01', endDate: null, bullets: ['Built the pipeline'] },
  });
  if (!isOk(addedR)) throw new Error('setup failed');
  const attached = profile.attachEmbedding(Array.from({ length: 768 }, (_, i) => i / 768), 'test-embed-model', profile.factsHash);
  if (!attached.ok) throw new Error('setup failed');
  await profiles.save(profile);

  const jobPostings = new DrizzleJobPostingRepository(db);
  const jobR = JobPosting.createManual({ userId: user.id, title: 'Engineer', descriptionMd: 'Build things.' });
  if (!isOk(jobR)) throw new Error('setup failed');
  jobR.value.attachEmbedding(Array.from({ length: 768 }, (_, i) => i / 768), 'test-embed-model');
  await jobPostings.save(jobR.value);

  return { user, profile, job: jobR.value };
}

/**
 * Task 043: proves `GuardedLlmPort` + the REAL `TieredCostEstimator` (033)
 * + `PostgresBudgetStore.withUserBudgetLock` (015/016) actually stop spend
 * at the configured limit under CONCURRENT load from M5's new call sites —
 * task 038's `score-match` and task 039's `tailor-document` — not a fake
 * flat-rate estimator, not a synthetic guard.complete() call. No new
 * locking logic here (that already exists); this is the M5-scope
 * regression proof the task asks for.
 */
describe('Budget hard-stop under concurrent load from M5 call sites (task 043)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('EXACT COUNT: 20 concurrent score-match requests for the same user, budget for exactly 3 calls — exactly 3 succeed, never more, and the 17 rejected calls write ZERO ai_invocations rows', async () => {
    const connections = await Promise.all(Array.from({ length: 20 }, () => createDb(TEST_URL)));
    const { user, profile } = await seedUserProfileAndJob(connections[0]!.db);

    // `TieredCostEstimator`'s PRE-dispatch estimate (033) is a char-length
    // heuristic over the real rendered prompt, deliberately conservative
    // (it assumes completion length ≈ prompt length when no maxTokens is
    // given) — a DIFFERENT number from the fixed 100/100-token ACTUAL cost
    // the stub's response declares below. Every one of the 20 concurrent
    // calls renders the IDENTICAL prompt (same profile/job), so that
    // estimate `E` is the same fixed value every time — computed here from
    // the REAL prompt (same facts/job text score-match.ts itself builds),
    // not guessed, so the budget boundary below is exact instead of a
    // "probably works" approximation.
    const estimator = new TieredCostEstimator(PRICING_TABLE);
    const facts = compileFactList(profile);
    const factsText = facts.length > 0 ? facts.map((f) => `${f.id}: ${f.text}`).join('\n') : '(no profile facts yet)';
    const promptResult = await new FilePromptStore(PROMPTS_DIR).load('match-score');
    if (!promptResult.ok) throw new Error('setup failed: could not load match-score prompt');
    const renderedPrompt = promptResult.value.render({
      profile_facts: factsText, job_title: 'Engineer', job_company: 'Unknown', job_description: 'Build things.',
    });
    const E = estimator.estimateCompleteCostUsd({ model: MODEL, prompt: renderedPrompt });

    // Accept while `j*ACTUAL + E <= BUDGET` (j = successes so far). Exactly
    // 3 successes requires BUDGET in [2*ACTUAL+E, 3*ACTUAL+E) — the
    // midpoint keeps it clear of both float-precision boundaries.
    const BUDGET = 2.5 * PER_CALL_COST + E;
    const stub = new CountingStubLlm();

    const runOne = async (db: Db) => {
      const guardedLlm = new GuardedLlmPort(
        stub, new PostgresBudgetStore(db), new TieredCostEstimator(PRICING_TABLE), BUDGET, 'test',
      );
      const scoreMatch = makeScoreMatchUseCase({
        profiles: new DrizzleProfileRepository(db),
        jobPostings: new DrizzleJobPostingRepository(db),
        matchScores: new DrizzleMatchScoreRepository(db),
        llm: guardedLlm,
        prompts: new FilePromptStore(PROMPTS_DIR),
        model: MODEL,
      });
      return scoreMatch({ profileId: profile.id, userId: user.id, limit: 1 });
    };

    const results = await Promise.all(connections.map((c) => runOne(c.db)));
    await Promise.all(connections.map((c) => c.close()));

    // Every call returns `ok` at the USE-CASE level (score-match collects
    // per-candidate failures into `failures`, it doesn't fail the whole
    // batch) — the real signal is how many candidates actually got scored.
    const scoredCounts = results.map((r) => (isOk(r) ? r.value.scored.length : 0));
    const totalScored = scoredCounts.reduce((a, b) => a + b, 0);
    expect(totalScored).toBe(3); // THE hard stop, exact — not "around 3", not "at most 3 on average"

    const rows = await withTestDb((db) =>
      db.execute(sql`SELECT status, cost_usd FROM ai_invocations WHERE user_id = ${user.id}`),
    );
    const invocations = rows as unknown as { status: string; cost_usd: string }[];
    expect(invocations).toHaveLength(3); // (b)/(c): the 17 rejected calls wrote NOTHING — not even a failed row
    expect(invocations.every((r) => r.status === 'ok')).toBe(true);
    const totalSpend = invocations.reduce((sum, r) => sum + Number(r.cost_usd), 0);
    expect(totalSpend).toBeCloseTo(PER_CALL_COST * 3, 10); // (a): spend never exceeds budget — here, exactly at the 3-call boundary
    expect(stub.dispatchCount).toBe(3); // the provider itself was only ever reached 3 times — rejection happens BEFORE dispatch, not after
  }, 30_000);

  it('a $0 budget rejects EVERY concurrent tailor-document request before any dispatch — zero ai_invocations rows, zero provider calls', async () => {
    const connections = await Promise.all(Array.from({ length: 8 }, () => createDb(TEST_URL)));
    const { user, profile, job } = await seedUserProfileAndJob(connections[0]!.db);

    const stub = new CountingStubLlm();
    const runOne = async (db: Db) => {
      const docsRepo = new DrizzleDocumentRepository(db);
      const docR = Document.create({ userId: user.id, kind: 'resume', title: 'Resume' });
      if (!isOk(docR)) throw new Error('setup failed');
      await docsRepo.save(docR.value);

      const guardedLlm = new GuardedLlmPort(
        stub, new PostgresBudgetStore(db), new TieredCostEstimator(PRICING_TABLE), 0, 'test', // $0 budget
      );
      const tailorDocument = makeTailorDocumentUseCase({
        uow: new DrizzleUnitOfWork(db),
        profiles: new DrizzleProfileRepository(db),
        jobPostings: new DrizzleJobPostingRepository(db),
        users: new DrizzleUserRepository(db),
        llm: guardedLlm,
        prompts: new FilePromptStore(PROMPTS_DIR),
        model: MODEL,
      });
      return tailorDocument({ documentId: docR.value.id, profileId: profile.id, jobPostingId: job.id, userId: user.id, kind: 'resume' });
    };

    const results = await Promise.all(connections.map((c) => runOne(c.db)));
    await Promise.all(connections.map((c) => c.close()));

    expect(results.every((r) => !r.ok)).toBe(true); // every single request rejected
    expect(results.every((r) => !r.ok && r.error.code === 'budget_exceeded')).toBe(true);

    const rows = await withTestDb((db) =>
      db.execute(sql`SELECT count(*)::int AS n FROM ai_invocations WHERE user_id = ${user.id}`),
    );
    expect((rows as unknown as { n: number }[])[0]!.n).toBe(0);
    expect(stub.dispatchCount).toBe(0); // the "provider" was NEVER reached — this is the guard rejecting pre-dispatch, not a downstream failure
  }, 30_000);

  it('MIXED concurrent fan-out: matching (038) + tailoring (039) requests interleaved via Promise.all against a shared low budget — spend never exceeds it, and at least one request of EACH kind is rejected', async () => {
    const connections = await Promise.all(Array.from({ length: 16 }, () => createDb(TEST_URL)));
    const { user, profile, job } = await seedUserProfileAndJob(connections[0]!.db);

    // Enough for a handful of calls total, nowhere near enough for all 16
    // concurrent requests (each tailor-document call alone needs 2:
    // generation + audit).
    const BUDGET = PER_CALL_COST * 5.5;
    const stub = new CountingStubLlm();

    type Kind = 'match' | 'tailor';
    const runOne = async (db: Db, kind: Kind) => {
      const guardedLlm = new GuardedLlmPort(
        stub, new PostgresBudgetStore(db), new TieredCostEstimator(PRICING_TABLE), BUDGET, 'test',
      );
      if (kind === 'match') {
        const scoreMatch = makeScoreMatchUseCase({
          profiles: new DrizzleProfileRepository(db),
          jobPostings: new DrizzleJobPostingRepository(db),
          matchScores: new DrizzleMatchScoreRepository(db),
          llm: guardedLlm,
          prompts: new FilePromptStore(PROMPTS_DIR),
          model: MODEL,
        });
        const r = await scoreMatch({ profileId: profile.id, userId: user.id, limit: 1 });
        return { kind, ok: isOk(r) && r.value.scored.length > 0 };
      }
      const docsRepo = new DrizzleDocumentRepository(db);
      const docR = Document.create({ userId: user.id, kind: 'resume', title: 'Resume' });
      if (!isOk(docR)) throw new Error('setup failed');
      await docsRepo.save(docR.value);
      const tailorDocument = makeTailorDocumentUseCase({
        uow: new DrizzleUnitOfWork(db),
        profiles: new DrizzleProfileRepository(db),
        jobPostings: new DrizzleJobPostingRepository(db),
        users: new DrizzleUserRepository(db),
        llm: guardedLlm,
        prompts: new FilePromptStore(PROMPTS_DIR),
        model: MODEL,
      });
      const r = await tailorDocument({ documentId: docR.value.id, profileId: profile.id, jobPostingId: job.id, userId: user.id, kind: 'resume' });
      return { kind, ok: r.ok };
    };

    const kinds: Kind[] = connections.map((_, i) => (i % 2 === 0 ? 'match' : 'tailor'));
    const results = await Promise.all(connections.map((c, i) => runOne(c.db, kinds[i]!)));
    await Promise.all(connections.map((c) => c.close()));

    // (b): the hard stop actually triggered for real requests of BOTH kinds, not just one.
    expect(results.some((r) => r.kind === 'match' && !r.ok)).toBe(true);
    expect(results.some((r) => r.kind === 'tailor' && !r.ok)).toBe(true);
    expect(results.some((r) => r.ok)).toBe(true); // and some genuinely succeeded — this isn't just "budget so low nothing ever runs"

    // (a): spend NEVER exceeds the configured budget, no matter how the
    // concurrent matching/tailoring calls interleaved.
    const rows = await withTestDb((db) =>
      db.execute(sql`SELECT COALESCE(SUM(cost_usd),0)::numeric AS total, count(*)::int AS n FROM ai_invocations WHERE user_id = ${user.id} AND status = 'ok'`),
    );
    const { total, n } = (rows as unknown as { total: string; n: number }[])[0]!;
    expect(Number(total)).toBeLessThanOrEqual(BUDGET);
    // Self-consistency: every recorded spend row corresponds to a real
    // dispatched call at the real per-call cost — no drift between what
    // the guard billed and what the estimator/pricing table say a call costs.
    expect(Number(total)).toBeCloseTo(n * PER_CALL_COST, 10);
    // (c), one layer up: the provider was reached exactly as many times as
    // there are 'ok' rows — never more (a rejected call never dispatches).
    expect(stub.dispatchCount).toBe(n);
  }, 30_000);
});
