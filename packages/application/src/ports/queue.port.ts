/**
 * Generic "fire a background job" port. Distinct from `OutboxPort`
 * (ADR-007) on purpose: the outbox exists to make an AGGREGATE WRITE and
 * its resulting event atomic — there's nothing to be atomic with here (a
 * resume upload doesn't write any aggregate row before parsing happens;
 * the profile write only happens later, at confirm time). A plain enqueue
 * is the honest shape for "kick off background work with no prior DB
 * state to protect," not a workaround.
 */
export interface QueuePort {
  enqueue(queueName: string, payload: Record<string, unknown>): Promise<void>;
}
