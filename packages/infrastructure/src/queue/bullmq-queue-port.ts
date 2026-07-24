import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { QueuePort } from '@careerpilot/application';

/**
 * Generic `QueuePort` over BullMQ — one `Queue` instance per queue name,
 * created lazily and cached (BullMQ's own guidance: don't recreate a Queue
 * per call). Distinct from `BullMqOutboxPublisher` (task 008), which is
 * purpose-built for draining outbox rows; this is for the simpler
 * "enqueue a background job with no prior DB write to protect" case task
 * 023 needs (see `queue.port.ts`'s docstring).
 */
export class BullMqQueuePort implements QueuePort {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly connection: Redis) {}

  private getQueue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(queueName: string, payload: Record<string, unknown>): Promise<void> {
    await this.getQueue(queueName).add(queueName, payload);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
