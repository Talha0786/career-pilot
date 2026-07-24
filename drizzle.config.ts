import type { Config } from 'drizzle-kit';

/**
 * NOTE: this repo does not use drizzle-kit's own migrator at runtime —
 * migrations are plain numbered .sql files applied by
 * `packages/infrastructure/src/db/migrate.ts` (task 013 rationale: no
 * ORM-specific migration format, just SQL + a `schema_migrations` tracking
 * table). This config exists so `pnpm db:generate`/`drizzle-kit check` can
 * diff the Drizzle schema (`packages/infrastructure/src/db/schema/index.ts`)
 * against the hand-written SQL migrations and catch drift — task 006/021
 * acceptance criterion ("drizzle-kit check passes") — without drizzle-kit
 * ever being the thing that actually runs a migration in prod.
 */
export default {
  dialect: 'postgresql',
  schema: './packages/infrastructure/src/db/schema/index.ts',
  out: './packages/infrastructure/src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot',
  },
} satisfies Config;
