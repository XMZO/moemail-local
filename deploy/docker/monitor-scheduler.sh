#!/bin/sh
set -u

config_reader=/app/deploy/docker/config-reader.mjs

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

interval="$(node "$config_reader" get monitor.intervalSeconds 300)"
next_run=0

while :; do
  now="$(date +%s)"
  latest_interval="$(node "$config_reader" get monitor.intervalSeconds 300)"
  case "$latest_interval" in
    ''|*[!0-9]*|0)
      echo "monitor.intervalSeconds must be a positive integer" >&2
      exit 64
      ;;
  esac
  if [ "$latest_interval" != "$interval" ]; then
    interval="$latest_interval"
    next_run="$(( now + interval ))"
    printf '{"event":"scheduler.config.applied","key":"monitor.intervalSeconds","value":%s}\n' "$interval"
  fi
  if [ "$now" -ge "$next_run" ]; then
    if ! pnpm monitor; then
      printf '{"event":"scheduler.job.failed","job":"monitor"}\n' >&2
      exit 1
    fi
    next_run="$(( now + interval ))"
  fi
  sleep 5 &
  wait $!
done
