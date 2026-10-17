# bilig_ft site image: the built client served by nginx, which also proxies
# /api and /cdn to the API container (same origin: no CORS, secure cookies).
# Build context: the bilig_ft repository root (see docker-compose.yml).
FROM node:20-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
COPY . .
# Same-origin API: VITE_API_URL stays empty.
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /src/dist /usr/share/nginx/html
COPY --from=bilig_back_deploy nginx/web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
