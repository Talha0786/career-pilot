import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, jsonb, integer, numeric, boolean,
  pgEnum, index, uniqueIndex, customType,
} from 'drizzle-orm/pg-core';

/**
 * M2 schema subset only (design §4) — no speculative tables. HNSW indexing
 * on `embedding` is deliberately deferred to M5 (real cardinality needed to
 * choose parameters sensibly).
 *
 * DIMENSION NOTE: the design doc specified vector(1024). Reality overrides
 * that: the local, key-free default embedding model (nomic-embed-text, per
 * ADR-006) emits 768 dimensions, and the column must match the model that
 * actually runs out of the box. Recorded here, not silently diverged.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .slice(1, -1)
      .split(',')
      .filter((s) => s.length > 0)
      .map(Number);
  },
});

export const userRoleEnum = pgEnum('user_role', ['owner', 'member']);
export const embeddingStatusEnum = pgEnum('embedding_status', ['pending', 'ready', 'failed']);
export const stageEnum = pgEnum('stage', [
  'discovered', 'interested', 'applied', 'screening',
  'interview', 'offer', 'rejected', 'withdrawn',
]);
export const transitionActorEnum = pgEnum('transition_actor', ['user', 'system', 'agent']);
export const invocationStatusEnum = pgEnum('invocation_status', ['ok', 'error']);
export const invocationContextEnum = pgEnum('invocation_context', [
  'matching', 'tailoring', 'interview', 'agent', 'parsing',
]);

// M4 (task 027) — connector configuration/health tracking + ingestion history,
// plus the job_postings columns M2 deliberately left out (design §2).
export const postingStatusEnum = pgEnum('posting_status', ['active', 'closed', 'expired']);
export const remoteTypeEnum = pgEnum('remote_type', ['remote', 'hybrid', 'onsite', 'unknown']);
export const connectorHealthEnum = pgEnum('connector_health', ['healthy', 'degraded', 'disabled']);
export const ingestionStatusEnum = pgEnum('ingestion_status', ['running', 'ok', 'partial', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull().default('owner'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // citext would be the ideal type; case-insensitive uniqueness via lower()
  // index is the portable equivalent and needs no extra extension privilege.
  emailUnique: uniqueIndex('users_email_unique').on(sql`lower(${t.email})`),
}));

export const jobPostings = pgTable('job_postings', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  sourceConnectorKey: text('source_connector_key').notNull().default('manual'),
  // M4 (task 027). Nullable — legacy/manual rows have no connector-native id.
  // A unique index on (source_connector_key, external_id) enforces "don't
  // ingest the same posting from the same source twice"; Postgres treats
  // every NULL as distinct for uniqueness purposes, so any number of NULL
  // rows (all pre-M4 rows, and every manual paste) coexist without collision
  // — no backfill needed for existing data (migration 0003's comment).
  externalId: text('external_id'),
  url: text('url'),
  urlHash: text('url_hash'),
  company: text('company'),
  title: text('title').notNull(),
  descriptionMd: text('description_md').notNull(),
  status: postingStatusEnum('status').notNull().default('active'),
  location: jsonb('location'),
  remote: remoteTypeEnum('remote').notNull().default('unknown'),
  salary: jsonb('salary'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  // Cross-source dedup group (task 029). Not a FK — it's a shared opaque
  // grouping key, not a row identifier of another table.
  dedupGroupId: uuid('dedup_group_id'),
  embeddingStatus: embeddingStatusEnum('embedding_status').notNull().default('pending'),
  embeddingModel: text('embedding_model'),
  embedding: vector('embedding'),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUserIngested: index('job_postings_user_ingested_idx').on(t.userId, t.ingestedAt.desc()),
  byUrlHash: index('job_postings_url_hash_idx').on(t.urlHash),
  bySourceExternalId: uniqueIndex('job_postings_source_external_unique').on(t.sourceConnectorKey, t.externalId),
  byDedupGroup: index('job_postings_dedup_group_idx').on(t.dedupGroupId),
}));

/** User-configured connector instances (task 027, design §2). */
export const connectorConfigs = pgTable('connector_configs', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectorKey: text('connector_key').notNull(),
  displayName: text('display_name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  scheduleCron: text('schedule_cron'),
  config: jsonb('config').notNull().default({}),
  // Points into the secrets store (env var name / secrets-manager key) —
  // NEVER a raw credential/API key value. Security model §4.
  credentialsRef: text('credentials_ref'),
  health: connectorHealthEnum('health').notNull().default('healthy'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('connector_configs_user_idx').on(t.userId),
  byUserConnectorKey: uniqueIndex('connector_configs_user_connector_unique').on(t.userId, t.connectorKey),
}));

/**
 * Append-only ingestion history (task 027/029), same enforcement posture as
 * `stage_transitions`/`outbox`: application code writes with `start()`
 * (INSERT) then `complete()` (UPDATE of the SAME row's terminal fields
 * only, never a historical row) — no row is ever deleted or rewritten to a
 * different run's data.
 */
export const ingestionRuns = pgTable('ingestion_runs', {
  id: uuid('id').primaryKey(),
  connectorConfigId: uuid('connector_config_id').notNull().references(() => connectorConfigs.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: ingestionStatusEnum('status').notNull().default('running'),
  stats: jsonb('stats').notNull().default({ fetched: 0, deduped: 0, inserted: 0 }),
  error: text('error'),
}, (t) => ({
  byConnectorConfig: index('ingestion_runs_connector_config_idx').on(t.connectorConfigId, t.startedAt.desc()),
}));

export const applications = pgTable('applications', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobPostingId: uuid('job_posting_id').notNull().references(() => jobPostings.id, { onDelete: 'cascade' }),
  stage: stageEnum('stage').notNull().default('discovered'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('applications_user_idx').on(t.userId),
}));

/** Append-only. Never UPDATE or DELETE a row here — see database design §2. */
export const stageTransitions = pgTable('stage_transitions', {
  id: uuid('id').primaryKey(),
  applicationId: uuid('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  fromStage: stageEnum('from_stage'),
  toStage: stageEnum('to_stage').notNull(),
  actor: transitionActorEnum('actor').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byApplication: index('stage_transitions_application_idx').on(t.applicationId, t.createdAt),
}));

/**
 * Transactional outbox (ADR-007). The relay's hot-path query is
 * "unpublished rows, oldest first" — the partial index makes that a cheap
 * index scan instead of a sequential scan over a table that only grows.
 */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
}, (t) => ({
  unpublished: index('outbox_unpublished_idx')
    .on(t.createdAt)
    .where(sql`${t.publishedAt} IS NULL`),
}));

/** Append-only cost/audit trail written by GuardedLlmPort. */
export const aiInvocations = pgTable('ai_invocations', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  context: invocationContextEnum('context').notNull(),
  refId: text('ref_id').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  latencyMs: integer('latency_ms').notNull().default(0),
  status: invocationStatusEnum('status').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUserCreated: index('ai_invocations_user_created_idx').on(t.userId, t.createdAt),
}));

/** Auth events, credential changes, job creation — security model §6. */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  detail: jsonb('detail').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
