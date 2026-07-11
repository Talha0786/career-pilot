# syntax=docker/dockerfile:1
# Build context is the monorepo root — see apps/api/Dockerfile for why.

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/infrastructure/package.json ./packages/infrastructure/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/domain ./packages/domain
COPY packages/application ./packages/application
COPY packages/contracts ./packages/contracts
COPY packages/infrastructure ./packages/infrastructure
COPY apps/web ./apps/web
# Baked in at build time — Next.js inlines rewrite destinations into the
# build, so this must be the in-network service name, not localhost.
ENV API_ORIGIN=http://api:8080
RUN pnpm --filter @careerpilot/web build

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S careerpilot && adduser -S careerpilot -G careerpilot
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# No apps/web/public directory yet (no static assets) — add a COPY line
# here if one shows up.
USER careerpilot
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
