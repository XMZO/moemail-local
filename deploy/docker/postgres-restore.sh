#!/bin/bash
set -Eeuo pipefail

umask 077

config_reader=/opt/moemail/config-reader.mjs
installed_primary=/app/data/config.yaml
installed_lkg=/app/data/config.yaml.lkg
frozen_primary="$(mktemp "${TMPDIR:-/tmp}/moemail-postgres-restore-primary.XXXXXX")"
frozen_installed="$(mktemp "${TMPDIR:-/tmp}/moemail-postgres-restore-installed.XXXXXX")"
frozen_setup_token="$(mktemp "${TMPDIR:-/tmp}/moemail-postgres-restore-token.XXXXXX")"
frozen_recovery="$(mktemp "${TMPDIR:-/tmp}/moemail-postgres-restore-recovery.XXXXXX")"
old_primary_exists=false
old_lkg_exists=false
old_setup_token_exists=false
safety_destination=""
safety_temporary=""
safety_temporary_owned=false

cleanup() {
  status=$?
  trap - EXIT
  rm -f -- "$frozen_primary" "$frozen_installed" "$frozen_setup_token" "$frozen_recovery"
  [ "$safety_temporary_owned" != "true" ] || rm -f -- "$safety_temporary"
  exit "$status"
}
trap cleanup EXIT

restore_file="${1:-}"
if [ -z "$restore_file" ] || [ "${2:-}" != "--confirm" ] || [ "$#" -ne 2 ]; then
  echo "Usage: moemail-postgres-restore <backup-file> --confirm" >&2
  exit 64
fi

case "$restore_file" in
  /*) source_file="$restore_file" ;;
  *) source_file="/backups/$restore_file" ;;
esac
if [ -L "$source_file" ] || [ ! -f "$source_file" ]; then
  echo "Backup file does not exist: $source_file" >&2
  exit 66
fi
source_config="${source_file}.config.yaml.lkg"
if [ -L "$source_config" ] || [ ! -f "$source_config" ]; then
  echo "Paired config snapshot does not exist: $source_config" >&2
  exit 66
fi

cp -- "$source_config" "$frozen_recovery"
chmod 0600 "$frozen_recovery"
node "$config_reader" --file "$frozen_recovery" validate-complete >/dev/null
read_recovery() {
  node "$config_reader" --file "$frozen_recovery" "$@"
}

database_driver="$(read_recovery get database.driver)"
if [ "$database_driver" != "postgres" ]; then
  echo "Backup config snapshot must select PostgreSQL" >&2
  exit 64
fi
configured_backup_directory="$(read_recovery get database.postgres.backupDir data/postgres-backups)"
case "$configured_backup_directory" in
  /*) backup_directory="$configured_backup_directory" ;;
  *) backup_directory="/app/$configured_backup_directory" ;;
esac

mkdir -p "$backup_directory"
# 与 backup 共用卷根固定锁，并在读取旧 installed state 前取得。
exec 9>/backups/.postgres-maintenance.lock
if ! flock --exclusive --timeout 60 9; then
  echo "Another PostgreSQL backup or restore operation is active" >&2
  exit 75
fi

for installed_path in "$installed_primary" "$installed_lkg" /app/data/setup-token; do
  if [ -L "$installed_path" ] \
    || { [ -e "$installed_path" ] && [ ! -f "$installed_path" ]; }; then
    echo "Installed runtime state must use regular files: $installed_path" >&2
    exit 65
  fi
done

if [ -f "$installed_primary" ]; then
  cp -- "$installed_primary" "$frozen_primary"
  chmod 0600 "$frozen_primary"
  old_primary_exists=true
fi
if [ -f "$installed_lkg" ]; then
  cp -- "$installed_lkg" "$frozen_installed"
  chmod 0600 "$frozen_installed"
  old_lkg_exists=true
fi
if [ -f /app/data/setup-token ]; then
  cp -- /app/data/setup-token "$frozen_setup_token"
  chmod 0600 "$frozen_setup_token"
  old_setup_token_exists=true
fi

ssl_mode="$(read_recovery postgres-sslmode)"
ssl_mode_source="$(read_recovery postgres-sslmode-source)"
while IFS='=' read -r environment_key _; do
  case "$environment_key" in PG*) unset "$environment_key" ;; esac
done < <(env)
postgres_fields=()
while IFS= read -r -d '' postgres_field; do
  postgres_fields+=("$postgres_field")
done < <(read_recovery postgres-fields)
if [ "${#postgres_fields[@]}" -ne 5 ]; then
  echo "Unable to materialize PostgreSQL target from recovery config" >&2
  exit 65
fi
export PGHOST="${postgres_fields[0]}"
export PGPORT="${postgres_fields[1]}"
export PGUSER="${postgres_fields[2]}"
export PGPASSWORD="${postgres_fields[3]}"
export PGDATABASE="${postgres_fields[4]}"
database_conninfo="$(read_recovery postgres-conninfo)"
export PGSSLMODE="$ssl_mode"
if [ "$ssl_mode" = "verify-full" ]; then
  export PGSSLROOTCERT=system
fi

restore_archive() {
  pg_restore \
    --dbname "$database_conninfo" \
    --clean \
    --if-exists \
    --exit-on-error \
    --single-transaction \
    --no-owner \
    --no-privileges \
    "$1"
}

verify_database() {
  psql \
    --dbname "$database_conninfo" \
    --no-psqlrc \
    --file /opt/moemail/postgres-verify.sql \
    >/dev/null
}

atomic_copy() {
  local source="$1"
  local destination="$2"
  local temporary
  temporary="$(mktemp "${destination}.restore.XXXXXX")" || return 1
  if ! cp -- "$source" "$temporary" || ! chmod 0600 "$temporary" \
    || ! mv -T -- "$temporary" "$destination" \
    || [ -L "$destination" ] || [ ! -f "$destination" ] \
    || ! cmp -s -- "$source" "$destination"; then
    rm -f -- "$temporary"
    return 1
  fi
}

install_recovery_config() {
  # Primary first: after the database switch, a crash must not leave an old
  # primary paired with the newly restored database. Cold boot can rebuild LKG.
  atomic_copy "$frozen_recovery" "$installed_primary" || return 1
  atomic_copy "$frozen_recovery" "$installed_lkg" || return 1
  rm -f -- /app/data/setup-token
}

restore_previous_config() {
  local result=0
  if [ "$old_primary_exists" = "true" ]; then
    atomic_copy "$frozen_primary" "$installed_primary" || result=1
  else
    rm -f -- "$installed_primary" || result=1
  fi
  if [ "$old_lkg_exists" = "true" ]; then
    atomic_copy "$frozen_installed" "$installed_lkg" || result=1
  else
    rm -f -- "$installed_lkg" || result=1
  fi
  if [ "$old_setup_token_exists" = "true" ]; then
    atomic_copy "$frozen_setup_token" /app/data/setup-token || result=1
  else
    rm -f -- /app/data/setup-token || result=1
  fi
  return "$result"
}

pg_restore --list "$source_file" >/dev/null

# safety dump 只供本次自动回滚。它不能冒充带新 pepper/secret 的恢复点，
# 因此刻意不生成 config pair，也不会被 offsite 或 retention 当作正常归档。
timestamp="$(date -u +'%Y-%m-%dT%H-%M-%S-%N')-$$"
safety_destination="${backup_directory}/pre-restore-${timestamp}.dump"
safety_temporary="${safety_destination}.tmp"
if [ -e "$safety_destination" ] || [ -L "$safety_destination" ] \
  || [ -e "$safety_temporary" ] || [ -L "$safety_temporary" ]; then
  echo "Safety backup destination already exists: $safety_destination" >&2
  exit 73
fi

safety_temporary_owned=true
pg_dump \
  --dbname "$database_conninfo" \
  --format custom \
  --compress 6 \
  --no-owner \
  --no-privileges \
  --file "$safety_temporary"
pg_restore --list "$safety_temporary" >/dev/null
if [ ! -s "$safety_temporary" ]; then
  echo "pg_dump created an empty safety archive" >&2
  exit 74
fi
mv -T -- "$safety_temporary" "$safety_destination"
safety_temporary_owned=false

failure_stage=""
database_mutated=false
if ! restore_archive "$source_file"; then
  failure_stage="pg_restore"
else
  database_mutated=true
  if ! verify_database; then
    failure_stage="post-restore verification"
  elif ! install_recovery_config; then
    failure_stage="config installation"
  fi
fi

if [ -n "$failure_stage" ]; then
  database_rolled_back=false
  config_rolled_back=false
  if [ "$database_mutated" != "true" ]; then
    echo "PostgreSQL restore was rejected before changing database or config" >&2
    exit 1
  fi
  restore_archive "$safety_destination" && database_rolled_back=true
  if [ "$database_rolled_back" = "true" ]; then
    restore_previous_config && config_rolled_back=true
  fi
  if [ "$database_rolled_back" = "true" ] && [ "$config_rolled_back" = "true" ]; then
    printf '{"event":"postgres.restore.rolled-back","source":"%s","safetyBackup":"%s","failedStage":"%s"}\n' \
      "$source_file" "$safety_destination" "$failure_stage" >&2
    echo "PostgreSQL restore failed; database and previous runtime config were restored" >&2
    exit 1
  fi
  printf 'PostgreSQL restore failed; rollback incomplete (database=%s, config=%s)\n' \
    "$database_rolled_back" "$config_rolled_back" >&2
  exit 1
fi

printf '{"event":"postgres.restore.ok","source":"%s","safetyBackup":"%s","configInstalled":true,"sslMode":"%s","sslModeSource":"%s"}\n' \
  "$source_file" "$safety_destination" "$ssl_mode" "$ssl_mode_source"
