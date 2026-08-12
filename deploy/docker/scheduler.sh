#!/bin/sh
set -u

config_reader=/app/deploy/docker/config-reader.cjs

config_get() {
  node "$config_reader" get "$1" "$2"
}

wait_for_config() {
  while :; do
    state="$(node "$config_reader" state)"
    status=$?
    if [ "$status" -ne 0 ]; then
      exit "$status"
    fi
    if [ "$state" = "ready" ]; then
      return
    fi
    sleep 5
  done
}

wait_for_config

cleanup_interval="$(config_get scheduler.cleanupIntervalSeconds 3600)"
backup_interval="$(config_get scheduler.backupIntervalSeconds 86400)"
backup_on_start="$(config_get scheduler.backupOnStart true)"
now="$(date +%s)"
next_cleanup=0
next_backup="$(( now + backup_interval ))"

if [ "$backup_on_start" = "true" ]; then
  next_backup=0
fi

trap 'exit 0' INT TERM HUP

while :; do
  now="$(date +%s)"
  latest_cleanup_interval="$(config_get scheduler.cleanupIntervalSeconds 3600)"
  latest_backup_interval="$(config_get scheduler.backupIntervalSeconds 86400)"
  latest_backup_on_start="$(config_get scheduler.backupOnStart true)"

  case "$latest_cleanup_interval:$latest_backup_interval" in
    *[!0-9:]*|0:*|*:0)
      echo "scheduler intervals must be positive integers" >&2
      exit 64
      ;;
  esac

  if [ "$latest_cleanup_interval" != "$cleanup_interval" ]; then
    cleanup_interval="$latest_cleanup_interval"
    next_cleanup="$(( now + cleanup_interval ))"
    printf '{"event":"scheduler.config.applied","key":"cleanupIntervalSeconds","value":%s}\n' "$cleanup_interval"
  fi
  if [ "$latest_backup_interval" != "$backup_interval" ]; then
    backup_interval="$latest_backup_interval"
    next_backup="$(( now + backup_interval ))"
    printf '{"event":"scheduler.config.applied","key":"backupIntervalSeconds","value":%s}\n' "$backup_interval"
  fi
  case "$latest_backup_on_start" in
    true|false) ;;
    *)
      echo "scheduler.backupOnStart must be true or false" >&2
      exit 64
      ;;
  esac
  if [ "$latest_backup_on_start" != "$backup_on_start" ]; then
    backup_on_start="$latest_backup_on_start"
    if [ "$backup_on_start" = "true" ]; then
      next_backup=0
    fi
    printf '{"event":"scheduler.config.applied","key":"backupOnStart","value":%s}\n' "$backup_on_start"
  fi

  if [ "$now" -ge "$next_cleanup" ]; then
    if ! /app/deploy/docker/entrypoint.sh cleanup; then
      printf '{"event":"scheduler.job.failed","job":"cleanup"}\n' >&2
      exit 1
    fi
    next_cleanup="$(( now + cleanup_interval ))"
  fi

  if [ "$(config_get database.driver sqlite)" = "sqlite" ] && [ "$now" -ge "$next_backup" ]; then
    if ! /app/deploy/docker/entrypoint.sh backup; then
      printf '{"event":"scheduler.job.failed","job":"backup"}\n' >&2
      exit 1
    fi
    next_backup="$(( now + backup_interval ))"
  fi

  # 最多 5 秒后重读 LKG；长间隔配置也不会把热更新阻塞在旧 sleep 中。
  sleep 5 &
  wait $!
done
