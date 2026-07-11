# ADR-007: Transactional Outbox for Domain Events

**Status:** Accepted | **Date:** 2026-07-09 | **Introduced by:** M2 walking skeleton

## Context
Contexts communicate via domain events (ADR-001, system design §2). Events must reach the worker via BullMQ. The naive implementation — `repo.save(job); await queue.add(event)` — is a **dual-write**: if the process dies between the two, the DB has the job and the queue never gets the event (lost work), or the queue gets an event for a transaction that later rolls back (phantom work). Both failures are silent and only appear under load or crash, which is exactly when they're hardest to debug.

This becomes a real decision in M2 rather than M5 because the walking skeleton deliberately crosses the queue boundary (paste → outbox → worker → embed → WS push), so the async spine is load-bearing from the first feature.

## Decision
**Transactional outbox.** Domain events are inserted into an `outbox` table *inside the same Postgres transaction* as the aggregate write. A relay polls unpublished rows and enqueues them to BullMQ, marking them published on success.

- `outbox`: `id (uuidv7)`, `aggregate_type`, `aggregate_id`, `event_type`, `payload jsonb`, `created_at`, `published_at (null)`, `attempts`, `last_error`.
- Relay: `FOR UPDATE SKIP LOCKED` batch poll (safe with N relay instances), publish, mark. Runs inside the `worker` process; no separate deployable.
- Delivery is **at-least-once** — the relay may crash after enqueue, before marking. Therefore **every consumer handler must be idempotent**, keyed by `outbox.id` or a natural content hash. This is a project-wide rule, enforced by handler contract tests.
- Poll interval 1s (tunable); the write path also emits an in-process nudge so latency is typically well under the interval.

## Consequences
+ No lost or phantom events; DB is the single source of truth for "did this happen."
+ `SKIP LOCKED` gives horizontal relay scaling for free.
+ Failure is visible: unpublished rows with `attempts > N` are an alertable condition, surfaced on `/admin/status`.
− At-least-once, not exactly-once — idempotent handlers are mandatory, not optional. Accepted; this is the standard trade and it's cheap when designed in from the first handler.
− Polling adds up to ~1s of event latency and a small constant DB load. Acceptable; nothing in this product is latency-critical at that scale.
− One more table and a relay loop to maintain.

## Rejected
- **Dual write** — silently lossy (see Context).
- **Postgres `LISTEN/NOTIFY`** — not durable; a notify is dropped if no listener is connected at that instant. Fine as a latency *nudge* on top of the outbox, not as the delivery mechanism.
- **CDC / logical decoding (Debezium)** — correct but heavyweight; another stateful service for a self-host product. Revisit only if event volume outgrows polling.
