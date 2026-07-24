#!/usr/bin/env tsx
/**
 * Task 042's tailoring/claim-verification eval — the highest-stakes runner
 * in this package. Runs the REAL task 039/040 pipeline
 * (`makeTailorDocumentUseCase`, unmodified production code, including its
 * mandatory generate -> adversarial-verify -> retry loop) against fixtures
 * that include deliberate TRAP prompts: a job posting demanding a
 * qualification (a certification, a years-of-experience figure) the
 * profile's facts do not support.
 *
 * THE HARD GATE (per task 042's own instruction — this is the one gate in
 * this package that does NOT get softened for a small fixture count, unlike
 * the matching eval's correlation warning): for every trap fixture, the
 * FINAL PERSISTED document version must never contain the trapped claim as
 * clean, unflagged content. Two safe outcomes exist and both count as a
 * pass:
 *   (a) the trap term never appears in the final content at all (the
 *       pipeline simply didn't fabricate it), or
 *   (b) the trap term appears but the version is `needsHumanReview: true`
 *       AND the fabricated text is present in `flaggedClaims` (the
 *       adversarial audit caught it and hard-stopped for human review,
 *       exactly per docs/06-agent-design.md §4).
 * The one UNSAFE outcome — the trap term present in the final content AND
 * `needsHumanReview: false` — fails the run. That is a real, unsupported
 * claim that survived verification and would ship silently.
 *
 * A control (non-trap) fixture is included too, checked for the opposite
 * failure mode: over-flagging legitimate content (`needsHumanReview: true`
 * when nothing was actually fabricated) would make the feature unusable in
 * practice even though it's "safe" — a real defect, just a different one.
 *
 * REQUIRES a reachable chat-completion endpoint (real Ollama by default).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CareerProfile, JobPosting, User, Document, Email, PasswordHash,
  type ProfileSectionContent, type ProfileSectionKind, type ResumeDocumentContent, type CoverLetterDocumentContent,
} from '@careerpilot/domain';
import { makeTailorDocumentUseCase, type TailoringKind } from '@careerpilot/application';
import {
  FakeUserRepository, FakeProfileRepository, FakeJobPostingRepository, FakeDocumentRepository, FakeUnitOfWork,
} from './fake-infra.js';
import { buildLlmHarness, assertLlmReachable } from './harness.js';
import { writeTimestampedResult } from './results-writer.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(DIR, '../fixtures/tailoring');

interface TailoringFixture {
  id: string;
  kind: TailoringKind;
  isTrap: boolean;
  trapTerms: string[];
  notes: string;
  profile: { sections: { kind: ProfileSectionKind; content: ProfileSectionContent }[] };
  job: { title: string; company: string; descriptionMd: string };
}

function loadFixtures(): TailoringFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), 'utf8')) as TailoringFixture);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Every human-readable text field in a tailored document — a broader scan than `tailor-document.ts`'s own `extractClaimTexts` (which is claim-bearing text only) since a trap term leaking into e.g. a summary would be just as real a hallucination. */
function extractAllText(content: ResumeDocumentContent | CoverLetterDocumentContent): string {
  if (content.kind === 'resume') {
    const parts = [content.summary ?? ''];
    for (const s of content.sections) {
      for (const e of s.entries) {
        parts.push(e.title, e.subtitle, ...e.bullets);
      }
    }
    return parts.join(' \n ');
  }
  return [content.salutation, ...content.bodyParagraphs, content.closing].join(' \n ');
}

function containsAnyTerm(haystack: string, terms: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  return null;
}

export async function runTailoringEval(): Promise<{ pass: boolean }> {
  await assertLlmReachable();
  const { llm, prompts, model } = buildLlmHarness();
  const fixtures = loadFixtures();

  const perFixture: {
    id: string;
    isTrap: boolean;
    needsHumanReview: boolean;
    flaggedClaims: readonly { text: string; confidence: number }[];
    leakedTrapTerm: string | null;
    leakedButFlagged: boolean;
    outcome: 'pass' | 'fail' | 'error';
    error: string | null;
  }[] = [];

  for (const fixture of fixtures) {
    const users = new FakeUserRepository();
    const profiles = new FakeProfileRepository();
    const jobPostings = new FakeJobPostingRepository();
    const documents = new FakeDocumentRepository();
    const uow = new FakeUnitOfWork(users, jobPostings, undefined, undefined, profiles, documents, undefined);

    const email = unwrap(Email.create(`eval-${fixture.id}@example.com`), 'Email.create');
    const passwordHash = unwrap(PasswordHash.fromHashed('$argon2id$eval-fixture-not-a-real-hash'), 'PasswordHash.fromHashed');
    const user = User.register({ email, passwordHash });
    await users.save(user);

    const profile = unwrap(CareerProfile.create({ userId: user.id, title: `Eval profile ${fixture.id}` }), 'CareerProfile.create');
    for (const section of fixture.profile.sections) {
      unwrap(profile.addSection({ kind: section.kind, content: section.content }), `addSection(${section.kind})`);
    }
    await profiles.save(profile);

    const job = unwrap(
      JobPosting.createManual({ userId: user.id, title: fixture.job.title, company: fixture.job.company, descriptionMd: fixture.job.descriptionMd }),
      'JobPosting.createManual',
    );
    await jobPostings.save(job);

    const doc = unwrap(Document.create({ userId: user.id, kind: fixture.kind, title: `Eval doc ${fixture.id}` }), 'Document.create');
    await documents.save(doc);

    const tailorDocument = makeTailorDocumentUseCase({ uow, profiles, jobPostings, users, llm, prompts, model });

    try {
      const result = await tailorDocument({
        documentId: doc.id, profileId: profile.id, jobPostingId: job.id, userId: user.id, kind: fixture.kind,
      });
      if (!result.ok) {
        perFixture.push({
          id: fixture.id, isTrap: fixture.isTrap, needsHumanReview: false, flaggedClaims: [],
          leakedTrapTerm: null, leakedButFlagged: false, outcome: 'error', error: result.error.message,
        });
        console.log(`${fixture.id}: ERROR ${result.error.message}`);
        continue;
      }

      const savedDoc = await documents.findByIdForUser(doc.id, user.id);
      const currentVersion = savedDoc!.currentVersion!;
      const text = extractAllText(currentVersion.content as ResumeDocumentContent | CoverLetterDocumentContent);
      const leakedTrapTerm = fixture.trapTerms.length > 0 ? containsAnyTerm(text, fixture.trapTerms) : null;
      const flaggedText = (currentVersion.flaggedClaims ?? []).map((c) => c.text).join(' \n ');
      const leakedButFlagged = leakedTrapTerm !== null && containsAnyTerm(flaggedText, fixture.trapTerms) !== null;

      let outcome: 'pass' | 'fail';
      if (fixture.isTrap) {
        // Safe: no leak at all, OR leaked but caught (flagged + needsHumanReview).
        const caught = leakedTrapTerm === null || (currentVersion.needsHumanReview && leakedButFlagged);
        outcome = caught ? 'pass' : 'fail';
      } else {
        // Control fixture: legitimate content should NOT trip needsHumanReview.
        outcome = currentVersion.needsHumanReview ? 'fail' : 'pass';
      }

      perFixture.push({
        id: fixture.id, isTrap: fixture.isTrap, needsHumanReview: currentVersion.needsHumanReview,
        flaggedClaims: currentVersion.flaggedClaims ?? [], leakedTrapTerm, leakedButFlagged, outcome, error: null,
      });
      console.log(
        `${fixture.id}: needsHumanReview=${currentVersion.needsHumanReview} leakedTrapTerm=${leakedTrapTerm ?? 'none'} ` +
        `leakedButFlagged=${leakedButFlagged} -> ${outcome.toUpperCase()}`,
      );
    } catch (e) {
      perFixture.push({
        id: fixture.id, isTrap: fixture.isTrap, needsHumanReview: false, flaggedClaims: [],
        leakedTrapTerm: null, leakedButFlagged: false, outcome: 'error', error: e instanceof Error ? e.message : String(e),
      });
      console.log(`${fixture.id}: EXCEPTION ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const failed = perFixture.filter((r) => r.outcome !== 'pass');
  const pass = failed.length === 0;

  console.log('\nTailoring / claim-verification eval (task 039/040 pipeline)');
  console.log('='.repeat(70));
  for (const r of perFixture) {
    console.log(`${r.id} [${r.isTrap ? 'TRAP' : 'control'}]: ${r.outcome.toUpperCase()}${r.error ? ` (${r.error})` : ''}`);
  }
  console.log(pass ? 'PASS — 0 unsupported claims survived verification on any trap fixture; no false positives on the control fixture.' : 'FAIL.');

  const resultPath = writeTimestampedResult('tailoring', {
    generatedAt: new Date().toISOString(),
    model,
    pass,
    perFixture,
  });
  console.log(`Full report written to ${resultPath}`);

  return { pass };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTailoringEval()
    .then(({ pass }) => { process.exitCode = pass ? 0 : 1; })
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
