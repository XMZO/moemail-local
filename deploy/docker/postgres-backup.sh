#!/bin/bash
set -Eeuo pipefail

umask 077

config_reader=/opt/moemail/config-reader.mjs
installed_lkg=/app/data/config.yaml.lkg
frozen_config="$(mktemp "${TMPDIR:-/tmp}/moemail-postgres-backup-config.XXXXXX")"
destination=""
temporary_destination=""
config_destination=""
temporary_config_destination=""
paired=false
destination_owned=false
temporary_destination_owned=false
config_destination_owned=false
temporary_config_destination_owned=false
snapshot_pid=""

cleanup() {
  status=$?
  trap - EXIT
  if [ -n "$snapshot_pid" ]; then
    kill "$snapshot_pid" 2>/dev/null || true
    wait "$snapshot_pid" 2>/dev/null || true
  fi
  rm -f -- "$frozen_config"
  [ "$temporary_destination_owned" != "true" ] || rm -f -- "$temporary_destination"
  [ "$temporary_config_destination_owned" != "true" ] || rm -f -- "$temporary_config_destination"
  if [ "$paired" != "true" ]; then
    [ "$destination_owned" != "true" ] || rm -f -- "$destination"
    [ "$config_destination_owned" != "true" ] || rm -f -- "$config_destination"
  fi
  exit "$status"
}
trap cleanup EXIT

# 固定在共享备份卷根目录；不能按可变 backupDir 分裂成多把锁。并且必须
# 在冻结 LKG 前取得，否则等待期间完成的 restore 会让 dump 与旧 pair 错配。
exec 9>/backups/.postgres-maintenance.lock
if ! flock --exclusive --timeout 60 9; then
  echo "Another PostgreSQL backup or restore operation is active" >&2
  exit 75
fi

# 原子改名的 LKG 先冻结到私有临时文件；本次备份的所有参数与配对快照都来自它。
if [ -L "$installed_lkg" ] || [ ! -f "$installed_lkg" ]; then
  echo "Installed config LKG must be a regular file" >&2
  exit 65
fi
cp -- "$installed_lkg" "$frozen_config"
chmod 0600 "$frozen_config"
node "$config_reader" --file "$frozen_config" validate-complete >/dev/null
read_config() {
  node "$config_reader" --file "$frozen_config" "$@"
}

database_driver="$(read_config get database.driver)"
if [ "$database_driver" != "postgres" ]; then
  echo "database.driver must be postgres for PostgreSQL backup" >&2
  exit 64
fi
ssl_mode="$(read_config postgres-sslmode)"
ssl_mode_source="$(read_config postgres-sslmode-source)"
while IFS='=' read -r environment_key _; do
  case "$environment_key" in PG*) unset "$environment_key" ;; esac
done < <(env)
postgres_fields=()
while IFS= read -r -d '' postgres_field; do
  postgres_fields+=("$postgres_field")
done < <(read_config postgres-fields)
if [ "${#postgres_fields[@]}" -ne 5 ]; then
  echo "Unable to materialize PostgreSQL target from config" >&2
  exit 65
fi
export PGHOST="${postgres_fields[0]}"
export PGPORT="${postgres_fields[1]}"
export PGUSER="${postgres_fields[2]}"
export PGPASSWORD="${postgres_fields[3]}"
export PGDATABASE="${postgres_fields[4]}"
database_conninfo="$(read_config postgres-conninfo)"
export PGSSLMODE="$ssl_mode"
if [ "$ssl_mode" = "verify-full" ]; then
  export PGSSLROOTCERT=system
fi

configured_backup_directory="$(read_config get database.postgres.backupDir data/postgres-backups)"
case "$configured_backup_directory" in
  /*) backup_directory="$configured_backup_directory" ;;
  *) backup_directory="/app/$configured_backup_directory" ;;
esac
retention_days="$(read_config get database.postgres.backupRetentionDays 14)"

case "$retention_days" in
  ''|*[!0-9]*)
    echo "database.postgres.backupRetentionDays must be a non-negative integer" >&2
    exit 64
    ;;
esac

mkdir -p "$backup_directory"
timestamp="$(date -u +'%Y-%m-%dT%H-%M-%S-%N')-$$"
destination="${backup_directory}/moemail-${timestamp}.dump"
temporary_destination="${destination}.tmp"
config_destination="${destination}.config.yaml.lkg"
temporary_config_destination="${config_destination}.tmp"
if [ -e "$destination" ] || [ -L "$destination" ] \
  || [ -e "$temporary_destination" ] || [ -L "$temporary_destination" ] \
  || [ -e "$config_destination" ] || [ -L "$config_destination" ] \
  || [ -e "$temporary_config_destination" ] || [ -L "$temporary_config_destination" ]; then
  echo "Backup destination already exists: $destination" >&2
  exit 73
fi

# 在一个保持打开的只读事务内完成 schema/唯一 Emperor 校验并导出 snapshot；
# pg_dump 导入同一 snapshot，避免校验与归档之间出现 TOCTOU 窗口。
coproc SNAPSHOT_SESSION {
  psql \
    --dbname "$database_conninfo" \
    --no-psqlrc \
    --quiet \
    --tuples-only \
    --no-align \
    --set ON_ERROR_STOP=1
}
snapshot_pid="$SNAPSHOT_SESSION_PID"
printf '%s\n' \
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
  '\i /opt/moemail/postgres-verify.sql' \
  "SELECT 'MOEMAIL_SNAPSHOT=' || pg_export_snapshot();" \
  >&"${SNAPSHOT_SESSION[1]}"
database_snapshot=""
while IFS= read -r snapshot_line <&"${SNAPSHOT_SESSION[0]}"; do
  case "$snapshot_line" in
    MOEMAIL_SNAPSHOT=*)
      database_snapshot="${snapshot_line#MOEMAIL_SNAPSHOT=}"
      break
      ;;
  esac
done
case "$database_snapshot" in
  ''|*[[:space:]]*)
    echo "PostgreSQL did not export a usable backup snapshot" >&2
    exit 74
    ;;
esac

temporary_destination_owned=true
pg_dump \
  --dbname "$database_conninfo" \
  --format custom \
  --compress 6 \
  --no-owner \
  --no-privileges \
  --snapshot "$database_snapshot" \
  --file "$temporary_destination"

printf '%s\n' 'ROLLBACK;' '\q' >&"${SNAPSHOT_SESSION[1]}"
wait "$snapshot_pid"
snapshot_pid=""

pg_restore --list "$temporary_destination" >/dev/null
if [ ! -s "$temporary_destination" ]; then
  echo "pg_dump created an empty archive" >&2
  exit 74
fi
mv -T -- "$temporary_destination" "$destination"
temporary_destination_owned=false
destination_owned=true
temporary_config_destination_owned=true
cp -- "$frozen_config" "$temporary_config_destination"
chmod 0600 "$temporary_config_destination"
mv -T -- "$temporary_config_destination" "$config_destination"
temporary_config_destination_owned=false
config_destination_owned=true
paired=true

pruned=0
if [ "$retention_days" -gt 0 ]; then
  canonical_backup_directory="$(readlink -f -- "$backup_directory")"
  while IFS= read -r -d '' expired; do
    expired_pair="${expired}.config.yaml.lkg"
    if [ ! -f "$expired_pair" ]; then
      echo "Skipping retention candidate without config pair: $expired" >&2
      continue
    fi
    if ! node "$config_reader" --file "$expired_pair" validate-complete >/dev/null 2>&1; then
      echo "Skipping retention candidate with incomplete config pair: $expired" >&2
      continue
    fi
    if ! pair_driver="$(node "$config_reader" --file "$expired_pair" get database.driver 2>/dev/null)" \
      || [ "$pair_driver" != "postgres" ]; then
      echo "Skipping retention candidate with invalid config pair: $expired" >&2
      continue
    fi
    if ! pair_configured_directory="$(node "$config_reader" --file "$expired_pair" get database.postgres.backupDir data/postgres-backups 2>/dev/null)"; then
      echo "Skipping retention candidate with unreadable backupDir: $expired" >&2
      continue
    fi
    case "$pair_configured_directory" in
      /*) pair_backup_directory="$pair_configured_directory" ;;
      *) pair_backup_directory="/app/$pair_configured_directory" ;;
    esac
    pair_canonical_directory="$(readlink -f -- "$pair_backup_directory" 2>/dev/null || true)"
    if [ -z "$pair_canonical_directory" ] \
      || [ "$pair_canonical_directory" != "$canonical_backup_directory" ]; then
      echo "Skipping retention candidate from another backup directory: $expired" >&2
      continue
    fi
    rm -f -- "$expired"
    rm -f -- "$expired_pair"
    pruned=$((pruned + 1))
  done < <(find "$backup_directory" -maxdepth 1 -type f \
    \( -name 'moemail-*.dump' -o -name 'pre-restore-*.dump' \) \
    -mtime "+$retention_days" -print0)
fi

printf '{"event":"postgres.backup.ok","destination":"%s","configSnapshot":"%s","sslMode":"%s","sslModeSource":"%s","pruned":%s}\n' \
  "$destination" "$config_destination" "$ssl_mode" "$ssl_mode_source" "$pruned"
