# Yonder production images (SPEC §5.2). Targets:
#   app     the Nitro server (.output/server) + the one-shot scripts
#           (.output/scripts: migrate.mjs reads ./drizzle, setup-bucket.mjs,
#           set-quota.mjs)
#   collab  the Hocuspocus server AND the BullMQ worker (same image; the worker
#           runs `node .output/collab/worker.mjs`). Its bundles keep sharp and
#           @tanstack/react-start external, so it ships the production
#           node_modules (no dev dependencies, no pnpm store) plus ffmpeg and
#           poppler-utils.
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS deps
RUN pnpm install --frozen-lockfile

# Production dependencies only, for the collab image.
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY . .
ARG VITE_COLLAB_URL=
# Inlined by vite build; .env is excluded by .dockerignore.
ENV VITE_COLLAB_URL=$VITE_COLLAB_URL
# vite build (+ service worker) -> build:collab -> build:scripts
RUN pnpm build
# The Japan rail graph (`pnpm data:jp`, ADDENDUM §5) is read at runtime with
# fs.readFile by the app (getTransitOptions) and the worker (autofill), so it
# ships as files. The directory always exists (empty until the data is built:
# getCapabilities().jpRail is then false).
RUN mkdir -p src/data/jp-rail

FROM node:22-bookworm-slim AS app
WORKDIR /app
COPY --from=build /app/.output ./.output
# migrate.mjs reads ./drizzle
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src/data/jp-rail ./src/data/jp-rail
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
USER 1000:1000
CMD ["node", ".output/server/index.mjs"]

FROM node:22-bookworm-slim AS collab
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.output/collab ./.output/collab
COPY --from=build /app/src/data/jp-rail ./src/data/jp-rail
ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe PDFTOPPM_PATH=/usr/bin/pdftoppm
EXPOSE 1234
USER 1000:1000
CMD ["node", ".output/collab/server.mjs"]
