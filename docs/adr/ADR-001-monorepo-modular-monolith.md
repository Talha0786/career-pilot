# ADR-001: TypeScript Monorepo, Modular Monolith

**Status:** Accepted (revisitable at M2 scaffolding) | **Date:** 2026-07-09

## Context
Multiple runtimes (api, worker, mcp-server, browser-runner, web) share domain logic. Options: polyrepo microservices, single app, monorepo modular monolith.

## Decision
pnpm workspaces + Turborepo monorepo. One deployable stack, five processes, shared `domain`/`application` packages. Fastify (api) for schema-first speed and low overhead; Next.js (web). Clean Architecture layering enforced with eslint-plugin-boundaries + tsconfig project references.

## Consequences
+ Atomic refactors across contexts; one CI; shared contracts package eliminates FE/BE drift.
+ DDD boundaries live in packages — extractable to services later without rewrite.
− Turborepo/pnpm learning curve for contributors; mitigated with CONTRIBUTING.md and generators.
− Shared failure domain on single-host deploys — accepted at self-host scale.

## Rejected
NestJS (heavier abstraction than needed; decorator DI conflicts with explicit composition-root style). Microservices (ops cost unjustifiable for self-host).
