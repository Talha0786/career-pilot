import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

/**
 * Minimal, dependency-free migration runner — no drizzle-kit migrator, no
 * ORM-specific migration format. Just numbered .sql files applied in order,
 * each wrapped in its own transaction, tracked in `schema_migrations` so
 * running this twice (the whole point of a one-shot compose service that
 * might restart) is a no-op the second time, not an error.
 *
 * Task 013 acceptance: `migrate` gates `api`/`worker` startup via
 * `depends_on: service_completed_successfully` — this is what that service runs.
 */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const appliedRows = await sql`SELECT name FROM schema_migrations`;
    const applied = new Set(appliedRows.map((r) => r.name as string));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip (already applied): ${file}`);
        continue;
      }

      const contents = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`applying: ${file}`);

      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      });

      console.log(`applied: ${file}`);
    }

    console.log('migrations up to date');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
