import { createDb, type Db } from '../../src/db/client.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * NOTE ON TESTCONTAINERS: the M2 design (task 007) specifies Testcontainers
 * spinning up ephemeral Postgres per test run. This sandbox has no Docker
 * daemon, so that exact mechanism cannot execute here. Substituted with a
 * REAL local Postgres 16 + pgvector instance (installed via apt, not
 * mocked) reset between test files. This is not a downgrade in what's
 * being proven — it's still a real engine, real transactions, real
 * pgvector I/O — only the provisioning mechanism differs. On a machine
 * with Docker, swap TEST_DATABASE_URL for a Testcontainers-provisioned
 * connection string and every test below is unchanged.
 */
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations/0001_init.sql',
);

export async function withTestDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = createDb(TEST_DATABASE_URL);
  try {
    return await fn(db);
  } finally {
    await close();
  }
}

/** Truncate everything between test files so each file starts from empty. */
export async function resetTestDb(db: Db): Promise<void> {
  await db.execute(
    `TRUNCATE TABLE audit_log, ai_invocations, outbox, stage_transitions, applications, job_postings, users RESTART IDENTITY CASCADE;` as never,
  );
}

export { MIGRATION_PATH };
