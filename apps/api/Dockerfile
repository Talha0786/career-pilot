# syntax=docker/dockerfile:1
#
# Build context is the MONOREPO ROOT (see docker-compose.yml's `build.context`),
# not this directory — pnpm workspaces need every package.json in the graph
# present to resolve the lockfile, even when only one app is actually served.
#
# No separate compile stage: packages/{domain,application,contracts,infrastructure}
# have no build step (task 011/012 both run straight off .ts source via tsx,
# same as `pnpm dev` locally) — this image just installs and runs it the same way.

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
# python3/make/g++ — argon2 and msgpackr-extract compile native bindings on
# install; alpine (musl) commonly has no prebuilt binary for these.
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/infrastructure/package.json ./packages/infrastructure/package.json
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup -S careerpilot && adduser -S careerpilot -G careerpilot
COPY --from=deps /app ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/domain ./packages/domain
COPY packages/application ./packages/application
COPY packages/contracts ./packages/contracts
COPY packages/infrastructure ./packages/infrastructure
COPY packages/connectors ./packages/connectors
COPY apps/api ./apps/api
USER careerpilot
WORKDIR /app/apps/api
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
