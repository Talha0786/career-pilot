import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import {
  createDb, type Db,
  DrizzleUnitOfWork, DrizzleProfileRepository, DrizzleJobPostingRepository, DrizzleUserRepository,
  DrizzleDocumentRepository, OpenAiCompatibleLlmAdapter, PostgresBudgetStore, FilePromptStore,
} from '@careerpilot/infrastructure';
import { GuardedLlmPort, TAILOR_DOCUMENT_QUEUE } from '@careerpilot/application';
import { CareerProfile, JobPosting, Document, User, Email, PasswordHash, isOk } from '@careerpilot/domain';
import { createTailorDocumentWorker } from '../../src/handlers/tailor-document.handler.js';
import pino from 'pino';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/2';
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../prompts');

/**
 * Task 039 end-to-end: tailoring.document_requested -> worker -> real
 * compileFactList (task 037) -> real prompts/tailor-resume/v1.md (task 034)
 * -> guarded LLM call against a local HTTP stand-in -> Document.addVersion
 * persisted to REAL Postgres, with the anti-hallucination structural gate
 * exercised against real data (not fakes). Mirrors score-match.test.ts's
 * shape one pipeline over.
 */
describe('End-to-end: tailoring.document_requested -> worker -> real fact list -> real prompt -> DocumentVersion persisted (task 039)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let redis: IORedis;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    db = conn.db;
    close = conn.close;
    await db.execute(sql`TRUNCATE audit_log, ai_invocations, outbox, document_versions, documents, profile_sections, career_profiles, job_postings, users RESTART IDENTITY CASCADE`);
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterEach(async () => {
    await close();
    await redis.quit();
  });

  it('tailors a real resume against real facts and persists a generated DocumentVersion with the correct profileFactsHash', async () => {
    const user = User.register({
      email: (() => { const r = Email.create('tailor-e2e@test.com'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
      passwordHash: (() => { const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y'); if (!isOk(r)) throw new Error('x'); return r.value; })(),
    });
    await db.execute(sql`INSERT INTO users (id, email, password_hash) VALUES (${user.id}, ${user.email.value}, ${user.passwordHash.value})`);

    const profiles = new DrizzleProfileRepository(db);
    const jobPostings = new DrizzleJobPostingRepository(db);
    const users = new DrizzleUserRepository(db);
    const documents = new DrizzleDocumentRepository(db);
    const uow = new DrizzleUnitOfWork(db);

    const profileR = CareerProfile.create({ userId: user.id, title: 'Profile' });
    if (!isOk(profileR)) throw new Error('setup failed');
    const profile = profileR.value;
    const addedR = profile.addSection({
      kind: 'experience',
      content: { schemaVersion: 1, title: 'Backend Engineer', organization: 'Acme', startDate: '2021-01', endDate: null, bullets: ['Built APIs serving 1M requests/day'] },
    });
    if (!isOk(addedR)) throw new Error('setup failed');
    await profiles.save(profile);

    const jobR = JobPosting.createManual({ userId: user.id, title: 'Senior Backend Engineer', descriptionMd: 'Build scalable APIs.' });
    if (!isOk(jobR)) throw new Error('setup failed');
    await jobPostings.save(jobR.value);

    const docR = Document.create({ userId: user.id, kind: 'resume', title: 'My Resume' });
    if (!isOk(docR)) throw new Error('setup failed');
    await documents.save(docR.value);

    // Compute the REAL fact id the worker's compileFactList will produce,
    // so the fake LLM server can cite it — proving the whole prompt/fact
    // pipeline is wired for real, not just that SOME string round-trips.
    const realFactId = 'F1'; // single experience section, single bullet -> F1

    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'test-tailor-model',
          choices: [{ message: { content: JSON.stringify({
            summary: 'Backend engineer focused on scalable APIs.',
            sections: [{
              heading: 'Experience',
              entries: [{
                title: 'Backend Engineer', subtitle: 'Acme', dateRange: '2021-present',
                bullets: [{ text: 'Built APIs serving 1M requests/day', supportingFactIds: [realFactId] }],
              }],
            }],
          }) } }],
          usage: { prompt_tokens: 80, completion_tokens: 40 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const inner = new OpenAiCompatibleLlmAdapter(`http://localhost:${port}`, null);
    const budgetStore = new PostgresBudgetStore(db);
    const estimator = {
      estimateEmbedCostUsd: () => 0, actualEmbedCostUsd: () => 0,
      estimateCompleteCostUsd: () => 0.0002, actualCompleteCostUsd: () => 0.0002,
    };
    const guardedLlm = new GuardedLlmPort(inner, budgetStore, estimator, 10, 'test-openai-compat');
    const prompts = new FilePromptStore(PROMPTS_DIR);

    const queue = new Queue(TAILOR_DOCUMENT_QUEUE, { connection: redis });
    const worker = createTailorDocumentWorker({
      connection: redis, uow, profiles, jobPostings, users, llm: guardedLlm, prompts,
      model: 'test-tailor-model', logger: pino({ level: 'silent' }),
    });

    try {
      await queue.add(TAILOR_DOCUMENT_QUEUE, {
        documentId: docR.value.id, profileId: profile.id, jobPostingId: jobR.value.id, userId: user.id, kind: 'resume',
      });

      const deadline = Date.now() + 10_000;
      let versionCount = 0;
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`SELECT count(*)::int AS n FROM document_versions WHERE document_id = ${docR.value.id}`);
        versionCount = (rows as unknown as { n: number }[])[0]!.n;
        if (versionCount > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(versionCount).toBe(1);

      const stored = await documents.findByIdForUser(docR.value.id, user.id);
      const version = stored!.currentVersion!;
      expect(version.source).toBe('generated');
      expect(version.profileFactsHash).toBe(profile.factsHash);
      expect(version.content.kind).toBe('resume');

      const content = version.content as unknown as {
        contact: { name: string; email: string };
        sections: { entries: { bullets: string[]; bulletFacts: { text: string; supportingFactIds: string[] }[] }[] }[];
      };
      expect(content.contact.email).toBe('tailor-e2e@test.com');
      expect(content.sections[0]!.entries[0]!.bulletFacts[0]!.supportingFactIds).toEqual([realFactId]);

      // Budget accounting happened for this `tailoring`-context completion call.
      const invocations = await db.execute(sql`SELECT status, context FROM ai_invocations WHERE user_id = ${user.id}`);
      expect(invocations).toHaveLength(1);
      expect((invocations as unknown as { status: string; context: string }[])[0]).toMatchObject({ status: 'ok', context: 'tailoring' });
    } finally {
      await worker.close();
      await queue.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15_000);
});
