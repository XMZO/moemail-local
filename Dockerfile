# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build-base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@11.21.0 \
  && pnpm --version \
  && npm cache clean --force

WORKDIR /app

FROM build-base AS dependencies

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS builder

ENV NODE_ENV=production

COPY . .
RUN pnpm build \
  && pnpm build:maintenance

FROM node:22-bookworm-slim AS runtime-base

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 moemail \
  && useradd --uid 10001 --gid moemail --create-home --home-dir /home/moemail moemail \
  && install -d -o moemail -g moemail -m 0700 \
    /app/data /app/data/backups /app/data/postgres-backups /backups

FROM runtime-base AS runtime

COPY --from=builder --chown=moemail:moemail /app/.next/standalone ./
COPY --from=builder --chown=moemail:moemail /app/.next/static ./.next/static
COPY --from=builder --chown=moemail:moemail /app/public ./public
# Keep migrations explicit even if a future Next.js trace stops discovering them.
COPY --from=builder --chown=moemail:moemail /app/drizzle-local ./drizzle-local
COPY --from=builder --chown=moemail:moemail /app/drizzle-postgres ./drizzle-postgres

USER moemail

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/internal/health').then(r=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

FROM runtime-base AS maintenance

USER root
HEALTHCHECK NONE

RUN apt-get update \
  && apt-get install --yes --no-install-recommends rclone \
  && rm -rf /var/lib/apt/lists/* \
  && rclone version

COPY --from=builder --chown=moemail:moemail /app/.next/maintenance/maintenance.mjs ./deploy/docker/maintenance.mjs
COPY --from=builder --chown=moemail:moemail /app/.next/maintenance/config-reader.cjs ./deploy/docker/config-reader.cjs
COPY --from=builder --chown=moemail:moemail /app/.next/maintenance/node_modules ./node_modules
COPY --from=builder --chown=moemail:moemail /app/drizzle-local ./drizzle-local
COPY --from=builder --chown=moemail:moemail /app/drizzle-postgres ./drizzle-postgres
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/scheduler.sh ./deploy/docker/scheduler.sh
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/monitor-scheduler.sh ./deploy/docker/monitor-scheduler.sh
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/offsite-backup-scheduler.sh ./deploy/docker/offsite-backup-scheduler.sh

RUN chmod 0555 /app/deploy/docker/entrypoint.sh \
  /app/deploy/docker/maintenance.mjs \
  /app/deploy/docker/config-reader.cjs \
  /app/deploy/docker/scheduler.sh \
  /app/deploy/docker/monitor-scheduler.sh \
  /app/deploy/docker/offsite-backup-scheduler.sh

USER moemail

VOLUME ["/app/data"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/docker/entrypoint.sh"]
CMD ["verify"]
