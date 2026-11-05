FROM oven/bun:1.4.4 AS bun
FROM node:26-bookworm-slim AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/wire/package.json packages/wire/package.json
COPY packages/rivetkit-svelte/package.json packages/rivetkit-svelte/package.json
RUN bun install --frozen-lockfile --production

FROM node:26-bookworm-slim
WORKDIR /app
COPY --from=dependencies /app /app
COPY apps/api/src apps/api/src
COPY packages/wire packages/wire
COPY scripts/start-api.mjs scripts/start-api.mjs
RUN date +%s > .release-version
ENV NODE_ENV=production API_HOST=:: PORT=3001
USER node
EXPOSE 3001
CMD ["node", "scripts/start-api.mjs"]
