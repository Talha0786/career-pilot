# ADR-002: PostgreSQL + pgvector + Drizzle

**Status:** Accepted (revisitable at M2 scaffolding) | **Date:** 2026-07-09

## Context
Need relational integrity (pipeline, versions), full-text search, and vector similarity (matching). Candidates: PG+pgvector, PG+Qdrant, SQLite+sqlite-vec, Mongo.

## Decision
Single PostgreSQL 16 with pgvector (HNSW) and native FTS. Drizzle ORM: SQL-first, zero runtime magic, first-class migrations, type inference without codegen drift.

## Consequences
+ One stateful dependency for self-hosters; transactional consistency between postings and embeddings.
+ HNSW adequate to ~1M postings — far beyond expected scale.
− Embedding dimension fixed per column; dimension change = migration + re-embed (documented procedure).
− No serverless PG assumption; compose ships the container.

## Rejected
SQLite: no mature vector story + multi-process workers. Qdrant: second stateful service unjustified at this scale. Prisma: heavier runtime, weaker raw-SQL ergonomics for vector ops.

---

## Amendment (2026-07-09): Postgres-only reconfirmed; no SQLite dialect

A dual Postgres/SQLite schema was requested and **rejected**. Reasoning:

- Dual dialects mean two versions of every migration, two integration-test suites, and a standing constraint that **no feature may use a Postgres-only capability** — which would forbid pgvector (M5 matching is built on it), JSONB operators, and native FTS. The constraint is not additive; it is subtractive from the product.
- A SQLite *test-only* dialect (the softer version) buys little: integration tests that don't run against real Postgres pass in CI and fail in production on exactly the pgvector/JSONB/FTS behavior that matters. We use **Testcontainers-backed Postgres** for integration tests instead — real engine, ephemeral, fast enough.

**Decision: PostgreSQL is the sole supported dialect for development, test, and production.** Local dev and CI use a containerized Postgres, not a file database. Recorded here so this is not relitigated per-milestone.
