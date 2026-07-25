# syntax=docker/dockerfile:1
#
# Build context is the MONOREPO ROOT (see docker-compose.yml's `build.context`),
# same reasoning as apps/api/Dockerfile and apps/worker/Dockerfile — pnpm
# workspaces need every package.json in the dependency graph present to
# resolve the lockfile. This image runs the Streamable HTTP/SSE transport
# (`main-http.ts`) as the `mcp-server` compose service; the stdio transport
# (`main-stdio.ts`) is invoked directly by desktop MCP clients, never
# containerized (task 056 acceptance).

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
COPY packages/connectors/package.json ./packages/connectors/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/mcp-server/package.json ./apps/mcp-server/package.json
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
COPY apps/mcp-server ./apps/mcp-server
COPY prompts ./prompts
USER careerpilot
WORKDIR /app/apps/mcp-server
EXPOSE 8090
CMD ["node", "--import", "tsx", "src/main-http.ts"]
