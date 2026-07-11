import { uuidv7 } from '@careerpilot/domain';
import type { OutboxPort, UnitOfWork, TransactionContext } from '@careerpilot/application';
import type { Db } from '../client.js';
import { outbox } from '../schema/index.js';
import { DrizzleUserRepository } from './user.repository.js';
import { DrizzleJobPostingRepository } from './job-posting.repository.js';
import { DrizzleApplicationRepository } from './application.repository.js';

export class DrizzleOutboxPort implements OutboxPort {
  constructor(private readonly db: Db) {}

  async enqueue(
    events: readonly { eventType: string; aggregateType: string; aggregateId: string; payload: unknown }[],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.db.insert(outbox).values(
      events.map((e) => ({
        id: uuidv7(),
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        eventType: e.eventType,
        payload: e.payload as Record<string, unknown>,
      })),
    );
  }
}

/**
 * Real transactional UnitOfWork — the thing that makes ADR-007 true rather
 * than aspirational. Every repo constructed inside `withTransaction` shares
 * the same underlying transaction handle, so the aggregate write and its
 * outbox row commit or roll back together, atomically, no exceptions.
 */
export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Db) {}

  async withTransaction<T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const ctx: TransactionContext = {
        users: new DrizzleUserRepository(tx as unknown as Db),
        jobPostings: new DrizzleJobPostingRepository(tx as unknown as Db),
        applications: new DrizzleApplicationRepository(tx as unknown as Db),
        outbox: new DrizzleOutboxPort(tx as unknown as Db),
      };
      return fn(ctx);
    });
  }
}
