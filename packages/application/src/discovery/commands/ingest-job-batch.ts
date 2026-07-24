import { JobPosting, asUserId, isOk } from '@careerpilot/domain';
import type { RawJob } from '../../ports/connector.port.js';
import type { UnitOfWork } from '../../ports/repositories.js';
import { findDedupMatch } from '../dedup.js';

export interface IngestJobBatchInput {
  readonly userId: string;
  readonly sourceConnectorKey: string;
  readonly rawJobs: readonly RawJob[];
}

export interface IngestJobBatchResult {
  readonly fetched: number;
  readonly deduped: number;
  readonly inserted: number;
  readonly skippedInvalid: number;
}

const DEDUP_CANDIDATE_POOL_SIZE = 500;

/**
 * Per-batch ingestion pipeline (task 029): normalize (already done —
 * `RawJob` IS the normalized shape, task 026) → dedup → upsert
 * `job_postings` → outbox event, one connector run at a time.
 *
 * Idempotent at the (source_connector_key, external_id) level: a job
 * already ingested from this exact source is skipped outright, neither
 * counted as `deduped` nor `inserted` — this is what makes a scheduled
 * re-run of the same connector cheap and safe (re-fetching jobs it already
 * has is not an error, not a duplicate-flag, just a no-op).
 *
 * Reuses the M2 outbox pattern via `UnitOfWork.withTransaction` (ADR-007) —
 * no new event-delivery mechanism (task 029 acceptance criterion). Each job
 * in the batch is its own transaction so one malformed job never rolls back
 * the rest of a good batch.
 */
export function makeIngestJobBatchUseCase(deps: { uow: UnitOfWork }) {
  return async function ingestJobBatch(input: IngestJobBatchInput): Promise<IngestJobBatchResult> {
    const userId = asUserId(input.userId);
    let deduped = 0;
    let inserted = 0;
    let skippedInvalid = 0;

    for (const raw of input.rawJobs) {
      // Idempotent re-fetch guard: worker path, unscoped by owner is fine —
      // the same connector run always targets the one user it's configured for.
      const alreadyIngested = await findExisting(deps, input.sourceConnectorKey, raw.externalId);
      if (alreadyIngested) continue;

      const created = JobPosting.ingest({
        userId,
        sourceConnectorKey: input.sourceConnectorKey,
        externalId: raw.externalId,
        title: raw.title,
        descriptionMd: raw.descriptionMd,
        company: raw.company,
        url: raw.url,
        location: raw.location,
        remote: raw.remote,
        salary: raw.salary,
        postedAt: raw.postedAt,
      });
      if (!isOk(created)) {
        skippedInvalid++;
        continue;
      }
      const job = created.value;

      const candidates = await listDedupCandidates(deps, input.userId);
      const decision = findDedupMatch({ urlHash: job.urlHash, title: job.title, company: job.company }, candidates);
      if (decision.kind !== 'unique') {
        job.assignDedupGroup(decision.groupId);
        deduped++;
        // The matched EXISTING posting may not have a dedup_group_id yet —
        // this is the first time it's been recognized as part of a group
        // (it was unique on its own until this batch's job matched it).
        // Backfill it so both rows carry the same group id, not "new job
        // has a group, original stays null."
        await backfillGroupIfMissing(deps, decision.matchId, decision.groupId);
      }

      await deps.uow.withTransaction(async (ctx) => {
        await ctx.jobPostings.save(job);
        const events = job.pullEvents();
        if (events.length > 0) await ctx.outbox.enqueue(events);
      });
      inserted++;
    }

    return { fetched: input.rawJobs.length, deduped, inserted, skippedInvalid };
  };
}

async function findExisting(deps: { uow: UnitOfWork }, sourceConnectorKey: string, externalId: string) {
  // Reads go through a throwaway transaction so this use case only depends
  // on UnitOfWork (matching every other M2 use case's dependency shape)
  // rather than also taking a raw JobPostingRepository.
  return deps.uow.withTransaction((ctx) => ctx.jobPostings.findBySourceAndExternalId(sourceConnectorKey, externalId));
}

async function listDedupCandidates(deps: { uow: UnitOfWork }, userId: string) {
  return deps.uow.withTransaction((ctx) => ctx.jobPostings.listDedupCandidatesForUser(asUserId(userId), DEDUP_CANDIDATE_POOL_SIZE));
}

async function backfillGroupIfMissing(deps: { uow: UnitOfWork }, matchedJobId: string, groupId: string): Promise<void> {
  await deps.uow.withTransaction(async (ctx) => {
    const existing = await ctx.jobPostings.findByIdAnyOwner(matchedJobId as never);
    if (existing && existing.dedupGroupId === null) {
      existing.assignDedupGroup(groupId);
      await ctx.jobPostings.save(existing);
    }
  });
}
