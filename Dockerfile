# Draftline in one container: the local API server (port 8787) and the web
# app (port 5173), with the database kept in /app/data, mounted from the
# computer so it survives rebuilds. See compose.yaml for how to run it.
#
# The Chrome extension can't run in a container: build it on the computer with
# `pnpm build:extension`, or take the zip from a GitHub release.

# The same Node major version as .nvmrc.
FROM node:26-slim AS base
# Recent Node releases no longer include Corepack, so pnpm comes from npm.
# This is the pnpm version that wrote pnpm-lock.yaml.
RUN npm install --global pnpm@9.1.4
WORKDIR /app

# Dependencies first, so they're only reinstalled when a manifest changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/extension/package.json apps/extension/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @draftline/web build

FROM base AS runtime
ENV NODE_ENV=production \
    # Listen on every interface inside the container so ports can be
    # forwarded; compose.yaml publishes them on the computer's 127.0.0.1 only.
    HOST=0.0.0.0 \
    # Inside the container "localhost" is the container itself, so local AI
    # models (Ollama) are reached through the computer's address instead.
    LOCALHOST_ALIAS=host.docker.internal
COPY --from=build --chown=node:node /app /app
# The database folder, owned by the unprivileged user the app runs as.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
