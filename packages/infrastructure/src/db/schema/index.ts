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

// M3 (task 021)
export const profileSectionKindEnum = pgEnum('profile_section_kind', [
  'experience', 'education', 'project', 'skill_group', 'certification', 'summary',
]);
export const documentKindEnum = pgEnum('document_kind', ['resume', 'cover_letter', 'other']);
export const documentVersionSourceEnum = pgEnum('document_version_source', [
  'imported', 'generated', 'edited',
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
 * M3 (task 021, design §2). `embedding` reuses the same vector(768) custom
 * type and the SAME dimension correction as `job_postings` (task 006/021 —
 * the design doc's 1024 is stale; nomic-embed-text emits 768).
 *
 * `career_profiles_user_active_unique` is defense-in-depth for the
 * application-layer "one active profile per user" policy enforced by
 * `createProfile` (task 020) — a partial unique index closes the race a
 * plain read-check-write would leave open under concurrency, same reasoning
 * as `users_email_unique`.
 */
export const careerProfiles = pgTable('career_profiles', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  summary: text('summary'),
  isActive: boolean('is_active').notNull().default(true),
  embeddingStatus: embeddingStatusEnum('embedding_status').notNull().default('pending'),
  embeddingModel: text('embedding_model'),
  embedding: vector('embedding'),
  embeddedFactsHash: text('embedded_facts_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('career_profiles_user_idx').on(t.userId),
  oneActivePerUser: uniqueIndex('career_profiles_user_active_unique')
    .on(t.userId)
    .where(sql`${t.isActive} = true`),
}));

/**
 * Structured content, one row per entry (design §2). `contentText` is
 * populated by the repository from `ProfileSection.toContentText()` (the
 * flattened text the domain already knows how to produce); `contentTsv` is
 * a REAL Postgres generated column derived from it — see migration SQL —
 * so FTS never drifts out of sync with `contentText` by construction. Not
 * modeled in the Drizzle table below since nothing here writes to it or
 * queries it yet (FTS search is a later milestone); it exists in the actual
 * schema per the migration file.
 */
export const profileSections = pgTable('profile_sections', {
  id: uuid('id').primaryKey(),
  profileId: uuid('profile_id').notNull().references(() => careerProfiles.id, { onDelete: 'cascade' }),
  kind: profileSectionKindEnum('kind').notNull(),
  sort: integer('sort').notNull().default(0),
  content: jsonb('content').notNull(),
  contentText: text('content_text').notNull().default(''),
}, (t) => ({
  byProfileSort: index('profile_sections_profile_sort_idx').on(t.profileId, t.sort),
}));

/**
 * design §2: "documents: id, user_id, kind, title, current_version_id,
 * deleted_at". `currentVersionId` deliberately has NO foreign-key
 * constraint — it would be circular with `document_versions.document_id`
 * (this table must exist before that one can reference it, and vice
 * versa). Referential integrity is enforced at the application layer
 * (`Document.attachRenderedArtifact`/`addVersion` only ever point it at a
 * version that was just inserted in the same transaction) rather than
 * paying for a deferred/ALTER-added constraint for a pointer-to-latest
 * field on an append-only child table that is never deleted.
 */
export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: documentKindEnum('kind').notNull(),
  title: text('title').notNull(),
  currentVersionId: uuid('current_version_id'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('documents_user_idx').on(t.userId),
}));

/**
 * Append-only (design §2 invariant, task 019/021 acceptance criterion):
 * deliberately has NO `updated_at` column and the repository (below) never
 * issues an UPDATE against this table — INSERT only, ever. The unique
 * constraint on (document_id, version) makes a duplicate version number a
 * hard DB error, not just an application-level convention.
 */
export const documentVersions = pgTable('document_versions', {
  id: uuid('id').primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  source: documentVersionSourceEnum('source').notNull(),
  content: jsonb('content').notNull(),
  renderedPdfKey: text('rendered_pdf_key'),
  generationJobId: uuid('generation_job_id'),
  profileFactsHash: text('profile_facts_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byDocument: index('document_versions_document_idx').on(t.documentId, t.version),
  uniqueVersion: uniqueIndex('document_versions_document_version_unique').on(t.documentId, t.version),
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
