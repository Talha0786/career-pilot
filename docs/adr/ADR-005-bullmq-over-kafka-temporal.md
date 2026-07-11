# ADR-005: BullMQ (Redis) for Async Work

**Status:** Accepted (revisitable at M2 scaffolding) | **Date:** 2026-07-09

## Context
Need scheduling, retries, backpressure for ingestion/matching/generation/export. Candidates: BullMQ, Kafka, Temporal, pg-boss.

## Decision
BullMQ on Redis. Long-lived state machines (ApplyTask, IngestionRun, GenerationJob) persist in Postgres; the queue only transports work. Transactional outbox bridges domain events → queue.

## Consequences
+ One small extra dependency (Redis, also used for cache/rate limits); simple ops; good TS ergonomics.
+ At-least-once + idempotency keys everywhere = safe redelivery.
− No durable workflow engine; long flows are explicit state machines — more code, less magic. Accepted; the flows are few and audited anyway.

## Rejected
Kafka (ops burden absurd at this scale). Temporal (great fit technically, but a heavyweight dependency for self-hosters; revisit if workflow count grows). pg-boss (viable; BullMQ chosen for rate-limiting/flow features and ecosystem maturity — recorded as the closest call in this set).
