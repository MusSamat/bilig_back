# bilig_back API image. Build context: the bilig_back repository root.
#   docker compose -f deploy/docker-compose.yml build api
#
# The API runs from TypeScript with tsx (as `npm start` does locally), so the
# image keeps dev dependencies (tsx, prisma CLI for migrations).
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first (cached while only sources change).
COPY package.json package-lock.json ./
COPY packages ./packages
COPY prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.base.json tsconfig.json ./
COPY src ./src
COPY scripts/db-seed.ts scripts/contract-hash.mjs ./scripts/
COPY assets ./assets
COPY data ./data
COPY content ./content
COPY deploy/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh

ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=${GIT_COMMIT} PORT=3000 HOST=0.0.0.0 STORAGE_DIR=/data/storage

RUN useradd --system --uid 10001 --home /app bilig && mkdir -p /data/storage && chown -R bilig /data
USER bilig

EXPOSE 3000
# start-period: a content import after a content change runs before the API listens and takes
# minutes on a small server (an unchanged start skips it). Healthy as soon as a check passes.
HEALTHCHECK --interval=15s --timeout=5s --start-period=900s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health || exit 1
ENTRYPOINT ["/usr/local/bin/api-entrypoint.sh"]
