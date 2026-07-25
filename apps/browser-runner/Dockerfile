# syntax=docker/dockerfile:1
# Build context is the monorepo root — see apps/api/Dockerfile for why.
#
# DELIBERATELY Debian-based (node:22-slim), NOT alpine like the other
# services' Dockerfiles: Playwright's bundled Chromium download does not
# work reliably against musl libc (alpine) — this is the single most common
# Playwright-in-Docker failure this task's own spec calls out, and it bites
# at "the browser launches" time, not at build time, so it's worth avoiding
# outright rather than debugging later. `playwright install --with-deps`
# below pulls the matching Debian system libraries (libnss3, libatk, etc)
# Chromium headless needs — this is what "install --with-deps" actually
# does beyond just downloading the browser binary.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/infrastructure/package.json ./packages/infrastructure/package.json
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/browser-runner/package.json ./apps/browser-runner/package.json
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
# Installed to a known, explicitly-owned path (not root's default
# ~/.cache/ms-playwright) so the non-root `careerpilot` user below can
# actually launch the browser — set BEFORE the install so Playwright
# downloads straight there instead of needing a copy/chown afterward.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN addgroup --system careerpilot && adduser --system --ingroup careerpilot careerpilot
COPY --from=deps /app ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/domain ./packages/domain
COPY packages/application ./packages/application
COPY packages/contracts ./packages/contracts
COPY packages/infrastructure ./packages/infrastructure
COPY packages/connectors ./packages/connectors
COPY apps/browser-runner ./apps/browser-runner
# REAL BUG FOUND AND FIXED DURING THIS TASK'S OWN VERIFICATION (not merely
# anticipated — see tasks/047.md's Status note for the full account):
# installing browsers via a version-pinned `npx playwright@X.Y.Z install`
# BEFORE `node_modules` existed in the image downloaded browser build v1148
# (matching CLI 1.49.1), but the ACTUAL `playwright` package pnpm resolved
# from `^1.49.1` in package.json was 1.61.1 at build time, which expects
# browser build v1228 — a version-mismatch launch failure
# ("browserType.launch: Executable doesn't exist..."), the exact "most
# common Playwright-in-Docker failure" this task's spec called out, just a
# different flavor (build-number drift) than the missing-system-libs one
# the comment above originally anticipated. Fixed by installing browsers
# via THIS project's own locally-resolved `playwright` binary (`pnpm
# --filter @careerpilot/browser-runner exec playwright install
# --with-deps chromium`), run AFTER `node_modules` is copied in — this is
# guaranteed to always match whatever version actually ships in the image,
# with no separate version number to keep in sync by hand.
RUN pnpm --filter @careerpilot/browser-runner exec playwright install --with-deps chromium
# Task 048's ATS-map fixtures / task 051's screenshot tmp dir — security
# posture (§6): no volume mounts except a tmp screenshot dir. Pre-create
# with correct ownership, same reasoning as apps/api/Dockerfile's data dir.
RUN mkdir -p /app/apps/browser-runner/tmp/screenshots \
  && chown -R careerpilot:careerpilot /app/apps/browser-runner/tmp \
  && chown -R careerpilot:careerpilot /app/.playwright-browsers
USER careerpilot
WORKDIR /app/apps/browser-runner
CMD ["node", "--import", "tsx", "src/main.ts"]
