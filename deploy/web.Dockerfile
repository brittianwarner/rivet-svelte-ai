FROM oven/bun:1.4.4 AS bun
FROM node:26-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/wire/package.json packages/wire/package.json
COPY packages/rivetkit-svelte/package.json packages/rivetkit-svelte/package.json
RUN bun install --frozen-lockfile
COPY apps apps
COPY packages packages
COPY turbo.json ./
ARG WEB_ORIGIN
ENV WEB_ORIGIN=$WEB_ORIGIN
RUN bun run build

FROM node:26-bookworm-slim
WORKDIR /app
COPY --from=build /app/apps/web/build ./apps/web/build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/packages ./packages
ENV NODE_ENV=production HOST=:: PORT=3000
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "build/index.js"]
