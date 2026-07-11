import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb, resetTestDb } from './setup.js';
import { OutboxRelay, type RelayablePublisher } from '../../src/queue/outbox-relay.js';
import { uuidv7 } from '@careerpilot/domain';
import { sql } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';

async function seedEvents(db: Db, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = uuidv7();
    ids.push(id);
    await db.execute(sql`
      INSERT INTO outbox (id, aggregate_type, aggregate_id, event_type, payload)
      VALUES (${id}, 'JobPosting', ${id}, 'discovery.job_posted', ${sql.raw(`'{"n":${i}}'::jsonb`)})
    `);
  }
  return ids;
}

/** Records every publish call so we can assert exactly-once across N relays. */
class RecordingPublisher implements RelayablePublisher {
  public published: string[] = [];
  async publish(event: { id: string }): Promise<void> {
    this.published.push(event.id);
  }
}

describe('OutboxRelay against REAL Postgres — SKIP LOCKED concurrency', () => {
  beforeEach(async () => {
    await withTestDb(async (db) => resetTestDb(db));
  });

  it('publishes every unpublished row and marks it published', async () => {
    await withTestDb(async (db) => {
      await seedEvents(db, 10);
      const publisher = new RecordingPublisher();
      const relay = new OutboxRelay(db, publisher);

      const stats = await relay.pollOnce(50);

      expect(stats.claimed).toBe(10);
      expect(stats.published).toBe(10);
      expect(publisher.published).toHaveLength(10);
      expect(await relay.getBacklogCount()).toBe(0);
    });
  });

  it('THE concurrency test: 3 relay instances racing over 300 events — every event published EXACTLY once', async () => {
    await withTestDb(async (db) => {
      const ids = await seedEvents(db, 300);

      // Three independent DB connections, each running its own relay loop
      // concurrently — this is what actually exercises SKIP LOCKED contention,
      // as opposed to three relays sharing one connection (which would
      // serialize trivially and prove nothing).
      const connections = await Promise.all([
        withTestDbConnection(),
        withTestDbConnection(),
        withTestDbConnection(),
      ]);

      const publishers = connections.map(() => new RecordingPublisher());
      const relays = connections.map(({ db: d }, i) => new OutboxRelay(d, publishers[i]!));

      // Each relay polls repeatedly until the backlog is drained, all three
      // running concurrently and genuinely racing for the same rows.
      async function drainLoop(relay: OutboxRelay): Promise<void> {
        for (let round = 0; round < 20; round++) {
          const stats = await relay.pollOnce(25);
          if (stats.claimed === 0) return;
        }
      }

      await Promise.all(relays.map(drainLoop));
      await Promise.all(connections.map((c) => c.close()));

      const allPublished = publishers.flatMap((p) => p.published);
      const uniquePublished = new Set(allPublished);

      // The assertion that actually matters: no id appears twice across ALL
      // three relays combined, and every seeded id was published by SOMEONE.
      expect(allPublished.length).toBe(uniquePublished.size); // no duplicates
      expect(uniquePublished.size).toBe(300); // nothing dropped
      for (const id of ids) expect(uniquePublished.has(id)).toBe(true);
    });
  });

  it('a failing publisher increments attempts and records the error without crashing the batch', async () => {
    await withTestDb(async (db) => {
      const ids = await seedEvents(db, 3);
      const flaky: RelayablePublisher = {
        publish: async (event) => {
          if (event.id === ids[1]) throw new Error('simulated publish failure');
        },
      };
      const relay = new OutboxRelay(db, flaky);

      const stats = await relay.pollOnce(50);
      expect(stats.claimed).toBe(3);
      expect(stats.published).toBe(2);
      expect(stats.failed).toBe(1);

      const failedRow = await db.execute(sql`SELECT attempts, last_error FROM outbox WHERE id = ${ids[1]}`);
      const row = (failedRow as unknown as { attempts: number; last_error: string }[])[0]!;
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('simulated publish failure');

      // The other two rows were unaffected by the third's failure.
      expect(await relay.getBacklogCount()).toBe(1);
    });
  });

  it('stops retrying past maxAttempts (does not loop forever on a poison event)', async () => {
    await withTestDb(async (db) => {
      const ids = await seedEvents(db, 1);
      const alwaysFails: RelayablePublisher = {
        publish: async () => { throw new Error('poison'); },
      };
      const relay = new OutboxRelay(db, alwaysFails, /* maxAttempts */ 3);

      await relay.pollOnce(50); // attempts -> 1
      await relay.pollOnce(50); // attempts -> 2
      await relay.pollOnce(50); // attempts -> 3
      const stats = await relay.pollOnce(50); // attempts already 3, excluded from WHERE clause

      expect(stats.claimed).toBe(0); // no longer picked up — visible on /admin/status instead
      const row = await db.execute(sql`SELECT attempts FROM outbox WHERE id = ${ids[0]}`);
      expect((row as unknown as { attempts: number }[])[0]!.attempts).toBe(3);
    });
  });
});

async function withTestDbConnection() {
  const { createDb } = await import('../../src/db/client.js');
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://careerpilot:careerpilot@localhost:5432/careerpilot_test';
  return createDb(url);
}
