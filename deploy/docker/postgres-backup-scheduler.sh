#!/bin/bash
set -u

config_reader=/opt/moemail/config-reader.mjs
schema_wait_seconds=300

# libpq 连接参数只允许来自已验证 YAML；清除所有继承的 PG* 隐式来源。
while IFS='=' read -r environment_key _; do
  case "$environment_key" in PG*) unset "$environment_key" ;; esac
done < <(env)

trap 'exit 0' INT TERM HUP

while :; do
  while [ "$(node "$config_reader" state)" != "ready" ] \
    || [ "$(node "$config_reader" get database.driver sqlite)" != "postgres" ]; do
    sleep 5
  done

  interval="$(node "$config_reader" get scheduler.backupIntervalSeconds 86400)"
  backup_on_start="$(node "$config_reader" get scheduler.backupOnStart true)"
  case "$interval" in
    ''|*[!0-9]*|0)
      echo "scheduler.backupIntervalSeconds must be a positive integer" >&2
      exit 64
      ;;
  esac
  case "$backup_on_start" in
    true|false) ;;
    *)
      echo "scheduler.backupOnStart must be true or false" >&2
      exit 64
      ;;
  esac

  deadline=$((SECONDS + schema_wait_seconds))
  schema_ready=false
  while [ "$(node "$config_reader" get database.driver sqlite)" = "postgres" ]; do
    database_url="$(node "$config_reader" get database.postgres.url)"
    ssl_mode="$(node "$config_reader" postgres-sslmode)"
    export PGSSLMODE="$ssl_mode"
    if [ "$ssl_mode" = "verify-full" ]; then
      export PGSSLROOTCERT=system
    else
      unset PGSSLROOTCERT
    fi
    schema_state="$(psql \
      --dbname "$database_url" \
      --no-psqlrc \
      --tuples-only \
      --no-align \
      --command "SELECT CASE WHEN to_regclass('public.site_config') IS NOT NULL AND to_regclass('public.message') IS NOT NULL THEN 'ready' ELSE 'waiting' END" \
      2>/dev/null || true)"
    if [ "$schema_state" = "ready" ]; then
      schema_ready=true
      break
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf '{"event":"scheduler.schema.wait.failed","job":"postgres-backup","timeoutSeconds":%s}\n' "$schema_wait_seconds" >&2
      exit 1
    fi
    sleep 5
  done
  if [ "$schema_ready" != "true" ]; then
    printf '{"event":"scheduler.driver.paused","job":"postgres-backup"}\n'
    continue
  fi

  now="$(date +%s)"
  if [ "$backup_on_start" = "true" ]; then
    next_run=0
  else
    next_run="$(( now + interval ))"
  fi

  while [ "$(node "$config_reader" get database.driver sqlite)" = "postgres" ]; do
    now="$(date +%s)"
    latest_interval="$(node "$config_reader" get scheduler.backupIntervalSeconds 86400)"
    latest_backup_on_start="$(node "$config_reader" get scheduler.backupOnStart true)"
    case "$latest_interval" in
      ''|*[!0-9]*|0)
        echo "scheduler.backupIntervalSeconds must be a positive integer" >&2
        exit 64
        ;;
    esac
    case "$latest_backup_on_start" in
      true|false) ;;
      *)
        echo "scheduler.backupOnStart must be true or false" >&2
        exit 64
        ;;
    esac

    if [ "$latest_interval" != "$interval" ]; then
      interval="$latest_interval"
      next_run="$(( now + interval ))"
      printf '{"event":"scheduler.config.applied","key":"backupIntervalSeconds","value":%s}\n' "$interval"
    fi
    if [ "$latest_backup_on_start" != "$backup_on_start" ]; then
      backup_on_start="$latest_backup_on_start"
      if [ "$backup_on_start" = "true" ]; then
        next_run=0
      fi
      printf '{"event":"scheduler.config.applied","key":"backupOnStart","value":%s}\n' "$backup_on_start"
    fi

    if [ "$next_run" -eq 0 ] || [ "$now" -ge "$next_run" ]; then
      if ! /usr/local/bin/moemail-postgres-backup; then
        if [ "$(node "$config_reader" get database.driver sqlite)" != "postgres" ]; then
          break
        fi
        printf '{"event":"scheduler.job.failed","job":"postgres-backup"}\n' >&2
        exit 1
      fi
      next_run="$(( now + interval ))"
    fi
    sleep 5 &
    wait $!
  done

  printf '{"event":"scheduler.driver.paused","job":"postgres-backup"}\n'
done
