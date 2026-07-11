import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, jsonb, integer, numeric,
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
  url: text('url'),
  urlHash: text('url_hash'),
  company: text('company'),
  title: text('title').notNull(),
  descriptionMd: text('description_md').notNull(),
  embeddingStatus: embeddingStatusEnum('embedding_status').notNull().default('pending'),
  embeddingModel: text('embedding_model'),
  embedding: vector('embedding'),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUserIngested: index('job_postings_user_ingested_idx').on(t.userId, t.ingestedAt.desc()),
  byUrlHash: index('job_postings_url_hash_idx').on(t.urlHash),
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
