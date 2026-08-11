# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@10.30.3 \
  && pnpm --version \
  && npm cache clean --force

WORKDIR /app

FROM base AS dependencies

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

FROM dependencies AS builder

ENV NODE_ENV=production

COPY . .
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM base AS runtime

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install --yes --no-install-recommends rclone tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 moemail \
  && useradd --uid 10001 --gid moemail --create-home --home-dir /home/moemail moemail \
  && install -d -o moemail -g moemail -m 0700 \
    /app/data /app/data/backups /app/data/postgres-backups /backups

COPY --from=production-dependencies --chown=moemail:moemail /app/node_modules ./node_modules
COPY --from=builder --chown=moemail:moemail /app/.next ./.next
COPY --from=builder --chown=moemail:moemail /app/public ./public
COPY --from=builder --chown=moemail:moemail /app/app ./app
COPY --from=builder --chown=moemail:moemail /app/scripts ./scripts
COPY --from=builder --chown=moemail:moemail /app/drizzle-local ./drizzle-local
COPY --from=builder --chown=moemail:moemail /app/drizzle-postgres ./drizzle-postgres
COPY --from=builder --chown=moemail:moemail /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=moemail:moemail /app/next.config.ts /app/next-intl.config.ts /app/tsconfig.json ./
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/entrypoint.sh ./deploy/docker/entrypoint.sh
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/config-reader.mjs ./deploy/docker/config-reader.mjs
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/scheduler.sh ./deploy/docker/scheduler.sh
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/monitor-scheduler.sh ./deploy/docker/monitor-scheduler.sh
COPY --from=builder --chown=moemail:moemail /app/deploy/docker/offsite-backup-scheduler.sh ./deploy/docker/offsite-backup-scheduler.sh

RUN chmod 0555 /app/deploy/docker/entrypoint.sh \
  /app/deploy/docker/config-reader.mjs \
  /app/deploy/docker/scheduler.sh \
  /app/deploy/docker/monitor-scheduler.sh \
  /app/deploy/docker/offsite-backup-scheduler.sh

USER moemail

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/internal/health').then(r=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/docker/entrypoint.sh"]
CMD ["serve"]
