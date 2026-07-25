import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { sql } from 'drizzle-orm';
import {
  createDb, type Db,
  DrizzleUserRepository, DrizzleProfileRepository, DrizzleJobPostingRepository, DrizzleApplicationRepository,
  DrizzleDocumentRepository, DrizzleMatchScoreRepository, DrizzleInterviewPrepRepository,
  DrizzleApplicationNoteRepository, DrizzleAuditPort, DrizzleUnitOfWork, McpTokenAdapter,
} from '@careerpilot/infrastructure';
import { NotYetImplementedApplyTaskPort } from '@careerpilot/application';
import { User, Email, PasswordHash, CareerProfile, JobPosting, Application, isOk } from '@careerpilot/domain';
import { McpRegistry } from '../../src/registry.js';
import { RedisRateLimiter } from '../../src/rate-limiter.js';
import { registerAllTools } from '../../src/tools/index.js';
import type { McpDeps } from '../../src/di.js';
import { stub } from '../fakes.js';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/3';

const email = (s: string) => {
  const r = Email.create(s);
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};
const hash = () => {
  const r = PasswordHash.fromHashed('$argon2id$v=19$m=65536,t=3,p=4$x$y');
  if (!isOk(r)) throw new Error('bad fixture');
  return r.value;
};

/**
 * Task 056/058's integration acceptance criteria against REAL Postgres +
 * Redis: real bearer-token verification, real `audit_log` rows, real
 * scope enforcement blocking a real mutation before it touches the
 * database. LLM-backed tools (tailor_document, match_job rubric,
 * generate_interview_prep) are deliberately NOT exercised here --
 * they're covered by application-layer unit tests with fakes
 * (packages/application/test/unit/interview-prep.test.ts) plus 038/039's
 * own existing real-Ollama integration coverage for the shared
 * GuardedLlmPort/prompt-loading machinery this task reuses verbatim, not
 * forks. A literal separate-process stdio/HTTP transport smoke test was
 * NOT run in this suite (see task 056/062's Status notes for what that
 * gap is and why) -- this test exercises the registry/DI/real-infra
 * layer the transports are thin wrappers around.
 */
describe('MCP server — registry against REAL Postgres + Redis (task 056/058)', () => {
  let db: Db;
  let closeDb: () => Promise<void>;
  let redis: IORedis;

  beforeEach(async () => {
    const conn = createDb(TEST_DATABASE_URL);
    db = conn.db;
    closeDb = conn.close;
    await db.execute(
      sql`TRUNCATE audit_log, mcp_tokens, interview_preps, application_notes, ai_invocations, outbox,
        stage_transitions, applications, job_postings, ingestion_runs, connector_configs, document_versions,
        documents, profile_sections, career_profiles, users RESTART IDENTITY CASCADE`,
    );
    redis = new IORedis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterAll(async () => {
    await closeDb?.();
    await redis?.quit();
  });

  async function buildWorld() {
    const users = new DrizzleUserRepository(db);
    const profiles = new DrizzleProfileRepository(db);
    const jobPostings = new DrizzleJobPostingRepository(db);
    const applications = new DrizzleApplicationRepository(db);
    const applicationNotes = new DrizzleApplicationNoteRepository(db);
    const audit = new DrizzleAuditPort(db);
    const tokens = new McpTokenAdapter(db);
    const uow = new DrizzleUnitOfWork(db);
    const rateLimiter = new RedisRateLimiter(redis, 1000);

    const deps: McpDeps = {
      db, uow, profiles, jobPostings, applications,
      documents: new DrizzleDocumentRepository(db),
      matchScores: new DrizzleMatchScoreRepository(db),
      interviewPreps: new DrizzleInterviewPrepRepository(db),
      applicationNotes,
      applyTasks: new NotYetImplementedApplyTaskPort(),
      search: stub('search'),
      fetcher: stub('fetcher'),
      queue: stub('queue'),
      audit, tokens,
      guardedLlm: stub('guardedLlm'),
      prompts: stub('prompts'),
      rateLimiter,
      llmModel: 'test-model',
    };

    const registry = new McpRegistry({ tokens, audit, rateLimiter });
    registerAllTools(registry, deps);

    const user = User.register({ email: email(`mcp-int-${Date.now()}@test.com`), passwordHash: hash() });
    await users.save(user);
    const profileR = CareerProfile.create({ userId: user.id, title: 'My Profile' });
    if (!isOk(profileR)) throw new Error('setup failed');
    await profiles.save(profileR.value);
    const jobR = JobPosting.createManual({ userId: user.id, title: 'Staff Engineer', company: 'Acme', descriptionMd: 'd' });
    if (!isOk(jobR)) throw new Error('setup failed');
    await jobPostings.save(jobR.value);
    const app = Application.create({ userId: user.id, jobPostingId: jobR.value.id });
    await applications.save(app);

    return { registry, tokens, user, profile: profileR.value, job: jobR.value, app, applications };
  }

  it('a real minted read-scoped token can call get_profile and list_applications, and real audit_log rows are written', async () => {
    const { registry, tokens, user } = await buildWorld();
    const { token } = await tokens.mint(user.id, 'test', ['read']);

    const profileResult = await registry.dispatch(token, 'get_profile', {});
    expect(profileResult.ok).toBe(true);

    const listResult = await registry.dispatch(token, 'list_applications', { limit: 10 });
    expect(listResult.ok).toBe(true);
    if (listResult.ok) expect((listResult.value as { items: unknown[] }).items).toHaveLength(1);

    const rows = await db.execute(sql`SELECT action, detail FROM audit_log WHERE user_id = ${user.id}`);
    expect((rows as unknown as unknown[]).length).toBe(2);
  });

  it('a read-only token is rejected with forbidden_scope on a write tool, and NO row is written', async () => {
    const { registry, tokens, user, app } = await buildWorld();
    const { token } = await tokens.mint(user.id, 'read-only', ['read']);

    const result = await registry.dispatch(token, 'update_application_stage', { applicationId: app.id, toStage: 'interested' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden_scope');

    const rows = await db.execute(sql`SELECT stage FROM applications WHERE id = ${app.id}`);
    expect((rows as unknown as { stage: string }[])[0]!.stage).toBe('discovered'); // unchanged
  });

  it('a write:pipeline token can really move a real application stage and add a real note', async () => {
    const { registry, tokens, user, app, applications } = await buildWorld();
    const { token } = await tokens.mint(user.id, 'writer', ['write:pipeline']);

    const stageResult = await registry.dispatch(token, 'update_application_stage', { applicationId: app.id, toStage: 'interested' });
    expect(stageResult.ok).toBe(true);

    const reloaded = await applications.findByIdForUser(app.id, user.id);
    expect(reloaded?.stage).toBe('interested');

    const noteResult = await registry.dispatch(token, 'add_application_note', { applicationId: app.id, noteMd: 'Looks promising.' });
    expect(noteResult.ok).toBe(true);

    const noteRows = await db.execute(sql`SELECT note_md, actor FROM application_notes WHERE application_id = ${app.id}`);
    const parsed = noteRows as unknown as { note_md: string; actor: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.note_md).toBe('Looks promising.');
    expect(parsed[0]!.actor).toBe('agent'); // MCP-token identity, not 'user' (task 058)
  });

  it('prepare_application against the not-yet-implemented M6 seam returns a typed conflict, never a crash', async () => {
    const { registry, tokens, user, app } = await buildWorld();
    const { token } = await tokens.mint(user.id, 'writer', ['write:pipeline']);
    const result = await registry.dispatch(token, 'prepare_application', { applicationId: app.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
  });
});
