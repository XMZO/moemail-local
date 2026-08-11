FROM postgres:18-bookworm

USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates nodejs npm util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -m 0755 /opt/moemail \
  && cd /opt/moemail \
  && npm install --omit=dev --no-audit --no-fund yaml@2.9.0 \
  && npm cache clean --force \
  && groupadd --gid 10001 moemail \
  && useradd --uid 10001 --gid moemail --create-home --home-dir /home/moemail moemail \
  && install -d -o moemail -g moemail -m 0700 \
    /app/data /app/data/postgres-backups /backups
COPY --chmod=0444 deploy/docker/config-reader.mjs /opt/moemail/config-reader.mjs
COPY --chmod=0444 deploy/docker/postgres-verify.sql /opt/moemail/postgres-verify.sql
COPY --chmod=0555 deploy/docker/postgres-backup.sh /usr/local/bin/moemail-postgres-backup
COPY --chmod=0555 deploy/docker/postgres-restore.sh /usr/local/bin/moemail-postgres-restore
COPY --chmod=0555 deploy/docker/postgres-backup-scheduler.sh /usr/local/bin/moemail-postgres-backup-scheduler
USER moemail
