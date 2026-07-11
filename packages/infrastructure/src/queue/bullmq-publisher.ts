import { Queue, type JobsOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { RelayablePublisher } from '@careerpilot/infrastructure';

/**
 * The concrete BullMQ side of ADR-007's outbox relay. `jobId: event.id`
 * makes BullMQ itself dedupe on top of outbox-level idempotency: if the
 * relay ever enqueues the same outbox row twice (crash-and-retry), BullMQ
 * silently ignores the second add rather than creating a duplicate job.
 * This is a second, independent idempotency layer — the handler (below)
 * still doesn't get to assume it, because at-least-once is still the
 * contract; this just makes double-delivery rarer, not impossible.
 */
export class BullMqOutboxPublisher implements RelayablePublisher {
  private queues = new Map<string, Queue>();

  constructor(private readonly connection: Redis) {}

  private queueFor(eventType: string): Queue {
    let q = this.queues.get(eventType);
    if (!q) {
      q = new Queue(eventType, { connection: this.connection });
      this.queues.set(eventType, q);
    }
    return q;
  }

  async publish(event: {
    id: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
  }): Promise<void> {
    const opts: JobsOptions = {
      jobId: event.id,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    };
    await this.queueFor(event.eventType).add(event.eventType, event.payload, opts);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
