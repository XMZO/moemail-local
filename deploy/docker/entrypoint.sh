#!/bin/sh
set -eu

umask 077

config_reader="/app/deploy/docker/config-reader.cjs"
maintenance="/app/deploy/docker/maintenance.mjs"

config_state() {
  node "$config_reader" state
}

config_get() {
  node "$config_reader" get "$1" "${2:-}"
}

require_ready() {
  state="$(config_state)"
  if [ "$state" != "ready" ]; then
    echo "MoeMail 尚未完成初始化，请先访问 WebUI 向导。" >&2
    exit 75
  fi
}

database_driver() {
  config_get database.driver sqlite
}

run_migrate() {
  node "$maintenance" migrate
}

run_verify() {
  node "$maintenance" verify
}

command="${1:-serve}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  serve)
    exec node server.js "$@"
    ;;
  migrate)
    require_ready
    run_migrate
    ;;
  verify)
    require_ready
    run_verify
    ;;
  cleanup)
    require_ready
    exec node "$maintenance" cleanup "$@"
    ;;
  backup)
    require_ready
    if [ "$(database_driver)" != "sqlite" ]; then
      echo "PostgreSQL backups use the postgres-backup Compose service." >&2
      exit 64
    fi
    exec node "$maintenance" backup "$@"
    ;;
  monitor)
    exec node "$maintenance" monitor "$@"
    ;;
  offsite-backup)
    exec node "$maintenance" offsite-backup "$@"
    ;;
  restore)
    # 恢复点旁的严格 pair 是目标数据库与配置的权威来源；全新卷或损坏
    # installed config 时也必须能自举。PostgreSQL Compose 仍应使用其
    # 带 pg_restore 的专用 postgres-restore service。
    exec node "$maintenance" restore "$@"
    ;;
  scheduler)
    exec /app/deploy/docker/scheduler.sh "$@"
    ;;
  monitor-scheduler)
    exec /app/deploy/docker/monitor-scheduler.sh "$@"
    ;;
  offsite-scheduler)
    exec /app/deploy/docker/offsite-backup-scheduler.sh "$@"
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
