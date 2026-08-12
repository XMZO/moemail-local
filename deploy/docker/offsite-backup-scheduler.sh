#!/bin/sh
set -u

config_reader=/app/deploy/docker/config-reader.cjs

while :; do
  state="$(node "$config_reader" state)"
  status=$?
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  if [ "$state" = "ready" ]; then
    break
  fi
  sleep 5
done

trap 'exit 0' INT TERM HUP

interval="$(node "$config_reader" get offsite.intervalSeconds 3600)"
next_run="$(( $(date +%s) + interval ))"

while :; do
  now="$(date +%s)"
  latest_interval="$(node "$config_reader" get offsite.intervalSeconds 3600)"
  case "$latest_interval" in
    ''|*[!0-9]*|0)
      echo "offsite.intervalSeconds must be a positive integer" >&2
      exit 64
      ;;
  esac
  if [ "$latest_interval" != "$interval" ]; then
    interval="$latest_interval"
    next_run="$(( now + interval ))"
    printf '{"event":"scheduler.config.applied","key":"offsite.intervalSeconds","value":%s}\n' "$interval"
  fi
  if [ "$now" -ge "$next_run" ]; then
    if ! /app/deploy/docker/entrypoint.sh offsite-backup; then
      printf '{"event":"scheduler.job.failed","job":"offsite-backup"}\n' >&2
      exit 1
    fi
    next_run="$(( now + interval ))"
  fi
  sleep 5 &
  wait $!
done
