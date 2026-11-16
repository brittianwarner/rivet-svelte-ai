# syntax=docker/dockerfile:1
#
# One image for every service. `apps/server` composes the packages; ROLE picks
# which of them a container runs:
#
#   ROLE=all (default)  engine node + actors + web/api/edge. Needs only S3_*.
#   ROLE=app            actors + web/api/edge; engine elsewhere (RIVET_ENDPOINT).
#   ROLE=engine         engine node only.
#   ROLE=runner         actor runner only.
#   ROLE=front          web + /api + /rivet only; stateless, scale freely.
#
# See docs/deployment.md before scaling or upgrading.
#
# The build context is pruned with `turbo prune @example/server`, so the image
# holds exactly the workspace packages the server depends on.
#
# Bump BOTH pins in one commit when upgrading: the engine image must match the
# rivetkit version in packages/actors/package.json.

ARG BUN_IMAGE=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
ARG ENGINE_IMAGE=rivetdev/engine:3.1.1@sha256:55cdfe9a92c0ee2f7d3ce5f388dab2ef8e0be1bab8e3f1adb7ba972f862e25d4
ARG TURBO_VERSION=2.11.10

FROM ${BUN_IMAGE} AS bun

# --- The server's slice of the workspace ------------------------------------
FROM ${BUN_IMAGE} AS prune
ARG TURBO_VERSION
WORKDIR /src
COPY . .
RUN bunx turbo@${TURBO_VERSION} prune @example/server --docker --out-dir /out

# --- Build the web app ------------------------------------------------------
FROM ${BUN_IMAGE} AS build
WORKDIR /src
# Manifests first: the install layer stays cached until a dependency changes.
COPY --from=prune /out/json/ ./
RUN bun install --frozen-lockfile
COPY --from=prune /out/full/ ./
ARG WEB_ORIGIN=
RUN WEB_ORIGIN="$WEB_ORIGIN" bunx turbo run build --filter=@example/server \
  && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
     apps/web/.svelte-kit .turbo

# --- Production dependencies only -------------------------------------------
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY --from=prune /out/json/ ./
RUN bun install --frozen-lockfile --production

# --- Runtime ----------------------------------------------------------------
# The engine image is the base so the engine runs on the libc it was built for.
FROM ${ENGINE_IMAGE}
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=build /src ./
COPY --from=deps /app ./

# A release keeps one runner version across restarts; new builds sort higher,
# so the engine drains old runners onto the new release during a deploy.
RUN date +%s > .release-version \
  && useradd --system --uid 10001 --home-dir /data app \
  && mkdir -p /data/rivet \
  && chown -R app /data

ENV NODE_ENV=production \
    ROLE=all \
    PORT=8080 \
    HOST=:: \
    RIVET_ENGINE_BIN=/usr/bin/rivet-engine \
    RIVET__STORAGE__LOG_DIRECTORY=/data/rivet

USER app
EXPOSE 8080
# Bun is PID 1 and handles SIGTERM itself: stop taking traffic, drain the
# runner, then stop the engine node. Give it the platform's full drain window.
STOPSIGNAL SIGTERM
ENTRYPOINT []
CMD ["bun", "apps/server/src/main.ts"]
