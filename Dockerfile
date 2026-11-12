# syntax=docker/dockerfile:1
#
# Quizora backend image. ONE image, several roles - the command decides:
#   runtime (default)  API server        CMD node dist/src/server.js
#   runtime            worker            command: node dist/src/worker.js
#   migrate            one-off job       CMD npx prisma migrate deploy   (needs the Prisma CLI, a dev dependency)
#
# Build:  docker build -t quizora-backend .                  (runtime image)
#         docker build --target migrate -t quizora-migrate .  (migration job image)
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

# 1) every dependency (dev included); cached until package*.json changes
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# 2) compile TypeScript and generate the Prisma client for THIS platform
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build

# 3) production dependencies only (no typescript, vitest, tsx, prisma CLI ...)
FROM base AS prod-deps
COPY package.json package-lock.json ./
# `prisma` and `typescript` are direct dev dependencies AND optional peers of @prisma/client, so npm keeps them even with --omit=dev.
# The runtime needs only the generated client (copied from the build stage), not the CLI, its engines or the compiler: drop them.
RUN npm ci --omit=dev && npm cache clean --force \n && rm -rf node_modules/prisma node_modules/typescript node_modules/effect \n    node_modules/@prisma/engines node_modules/@prisma/config node_modules/@prisma/fetch-engine \n    node_modules/@prisma/get-platform node_modules/@prisma/engines-version node_modules/@prisma/debug \n && rm -f node_modules/.bin/prisma node_modules/.bin/tsc node_modules/.bin/tsserver

# 4) migration job: build stage + CLI + migrations. Runs `prisma migrate deploy`, then exits.
FROM build AS migrate
ENV NODE_ENV=production
RUN npx prisma --version >/dev/null   # fetch the schema engine now, so the job needs no internet at run time
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# 5) runtime: small, non-root, no build tools
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# the generated Prisma client (query engine) lives outside @prisma/client
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4000
# Liveness only (never depends on the database). The worker has no HTTP port: override or disable this check for it.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# `docker stop` sends SIGTERM; server.ts and worker.ts handle it and exit cleanly.
CMD ["node", "dist/src/server.js"]
