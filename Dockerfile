# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /srv/mail/data \
  && chown -R node:node /srv/mail
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node scripts/healthcheck.mjs scripts/docker-entrypoint.mjs ./scripts/
ENV NODE_ENV=production \
  MAIL_DATA_DIR=/srv/mail/data \
  API_HOST=0.0.0.0 \
  API_PORT=8080 \
  SMTP_HOST=0.0.0.0 \
  SMTP_PORT=2525
# Root only long enough for the entrypoint to chown a bind mount and drop to node.
EXPOSE 2525 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node scripts/healthcheck.mjs
ENTRYPOINT ["node", "scripts/docker-entrypoint.mjs"]
CMD ["dist/main.js"]
