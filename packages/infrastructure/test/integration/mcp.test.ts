import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTestDb, resetTestDb } from './setup.js';
import { DrizzleUserRepository } from '../../src/db/repositories/user.repository.js';
import { DrizzleApplicationRepository } from '../../src/db/repositories/application.repository.js';
import { DrizzleJobPostingRepository } from '../../src/db/repositories/job-posting.repository.js';
import { DrizzleInterviewPrepRepository } from '../../src/db/repositories/interview-prep.repository.js';
import { DrizzleApplicationNoteRepository } from '../../src/db/repositories/application-note.repository.js';
import { McpTokenAdapter } from '../../src/auth/mcp-token.adapter.js';
import { User, Email, PasswordHash, Application, JobPosting, isOk } from '@careerpilot/domain';

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

describe('McpTokenAdapter — REAL Postgres (task 056)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('mint returns a usable plaintext token; verify round-trips userId/scopes; only a hash is ever stored', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const tokens = new McpTokenAdapter(db);
      const user = User.register({ email: email('mcp1@test.com'), passwordHash: hash() });
      await users.save(user);

      const { id, token } = await tokens.mint(user.id, 'My Claude Desktop', ['read', 'write:pipeline']);
      expect(token).toMatch(/^cpmcp_/);

      const verified = await tokens.verify(token);
      expect(verified).not.toBeNull();
      expect(verified!.userId).toBe(user.id);
      expect([...verified!.scopes].sort()).toEqual(['read', 'write:pipeline']);
      expect(verified!.tokenId).toBe(id);

      // The plaintext token must never be recoverable from storage.
      const row = await db.execute(sql`SELECT token_hash FROM mcp_tokens WHERE id = ${id}`);
      const hashCol = (row as unknown as { token_hash: string }[])[0]!.token_hash;
      expect(hashCol).not.toBe(token);
      expect(hashCol).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    });
  });

  it('an unrecognized token string verifies to null, not a crash', async () => {
    await withTestDb(async (db) => {
      const tokens = new McpTokenAdapter(db);
      const verified = await tokens.verify('cpmcp_this-was-never-minted');
      expect(verified).toBeNull();
    });
  });

  it('a revoked token verifies to null', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const tokens = new McpTokenAdapter(db);
      const user = User.register({ email: email('mcp2@test.com'), passwordHash: hash() });
      await users.save(user);
      const { id, token } = await tokens.mint(user.id, 'label', ['read']);

      expect(await tokens.verify(token)).not.toBeNull();
      const revoked = await tokens.revoke(id, user.id);
      expect(revoked).toBe(true);
      expect(await tokens.verify(token)).toBeNull();
    });
  });

  it('revoke is ownership-scoped -- another user cannot revoke someone else\'s token', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const tokens = new McpTokenAdapter(db);
      const owner = User.register({ email: email('mcp3@test.com'), passwordHash: hash() });
      const attacker = User.register({ email: email('mcp4@test.com'), passwordHash: hash() });
      await users.save(owner);
      await users.save(attacker);
      const { id, token } = await tokens.mint(owner.id, 'label', ['read']);

      const revoked = await tokens.revoke(id, attacker.id);
      expect(revoked).toBe(false);
      expect(await tokens.verify(token)).not.toBeNull(); // still valid -- the attacker's attempt had no effect
    });
  });

  it('list returns only the calling user\'s tokens', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const tokens = new McpTokenAdapter(db);
      const userA = User.register({ email: email('mcp5@test.com'), passwordHash: hash() });
      const userB = User.register({ email: email('mcp6@test.com'), passwordHash: hash() });
      await users.save(userA);
      await users.save(userB);
      await tokens.mint(userA.id, 'a1', ['read']);
      await tokens.mint(userA.id, 'a2', ['write:documents']);
      await tokens.mint(userB.id, 'b1', ['read']);

      const listA = await tokens.list(userA.id);
      expect(listA).toHaveLength(2);
      expect(listA.every((t) => t.userId === userA.id)).toBe(true);
    });
  });
});

describe('DrizzleInterviewPrepRepository — REAL Postgres (task 060/061)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('save is upsert-by-id (the mock-interview transcript-grows-per-turn case) and listForApplication filters by kind', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobPostings = new DrizzleJobPostingRepository(db);
      const applications = new DrizzleApplicationRepository(db);
      const interviewPreps = new DrizzleInterviewPrepRepository(db);

      const user = User.register({ email: email('ip1@test.com'), passwordHash: hash() });
      await users.save(user);
      const jobR = JobPosting.createManual({ userId: user.id, title: 'Eng', descriptionMd: 'd' });
      if (!isOk(jobR)) throw new Error('setup failed');
      await jobPostings.save(jobR.value);
      const app = Application.create({ userId: user.id, jobPostingId: jobR.value.id });
      await applications.save(app);

      const sessionId = '018f0000-0000-7000-8000-0000000000f1';
      await interviewPreps.save({ id: sessionId, applicationId: app.id, kind: 'mock_interview_transcript', content: { turns: [1] } });
      await interviewPreps.save({ id: sessionId, applicationId: app.id, kind: 'mock_interview_transcript', content: { turns: [1, 2] } });
      await interviewPreps.save({ id: '018f0000-0000-7000-8000-0000000000f2', applicationId: app.id, kind: 'questions', content: { questions: [] } });

      const transcripts = await interviewPreps.listForApplication(app.id, 'mock_interview_transcript');
      expect(transcripts).toHaveLength(1); // upsert, not append
      expect((transcripts[0]!.content as { turns: number[] }).turns).toEqual([1, 2]);

      const all = await interviewPreps.listForApplication(app.id);
      expect(all).toHaveLength(2); // one transcript + one questions row
    });
  });
});

describe('DrizzleApplicationNoteRepository — REAL Postgres (task 058)', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('append-only: multiple notes accumulate, ordered most recent first', async () => {
    await withTestDb(async (db) => {
      const users = new DrizzleUserRepository(db);
      const jobPostings = new DrizzleJobPostingRepository(db);
      const applications = new DrizzleApplicationRepository(db);
      const notes = new DrizzleApplicationNoteRepository(db);

      const user = User.register({ email: email('note1@test.com'), passwordHash: hash() });
      await users.save(user);
      const jobR = JobPosting.createManual({ userId: user.id, title: 'Eng', descriptionMd: 'd' });
      if (!isOk(jobR)) throw new Error('setup failed');
      await jobPostings.save(jobR.value);
      const app = Application.create({ userId: user.id, jobPostingId: jobR.value.id });
      await applications.save(app);

      await notes.add({ id: '018f0000-0000-7000-8000-000000000101', applicationId: app.id, noteMd: 'first', actor: 'user' });
      await notes.add({ id: '018f0000-0000-7000-8000-000000000102', applicationId: app.id, noteMd: 'second (from MCP)', actor: 'agent' });

      const list = await notes.listForApplication(app.id);
      expect(list).toHaveLength(2);
      expect(list[0]!.noteMd).toBe('second (from MCP)');
      expect(list[0]!.actor).toBe('agent');
      expect(list[1]!.noteMd).toBe('first');
    });
  });
});
