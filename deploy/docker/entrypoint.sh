#!/bin/sh
set -eu

umask 077

config_reader="/app/deploy/docker/config-reader.mjs"

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
  pnpm "db:$(database_driver):migrate"
}

run_verify() {
  pnpm "db:$(database_driver):verify"
}

command="${1:-serve}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  serve)
    exec pnpm start --hostname 0.0.0.0 --port 3000 "$@"
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
    exec pnpm cleanup "$@"
    ;;
  backup)
    require_ready
    if [ "$(database_driver)" != "sqlite" ]; then
      echo "PostgreSQL backups use the postgres-backup Compose service." >&2
      exit 64
    fi
    exec pnpm db:sqlite:backup "$@"
    ;;
  restore)
    # 恢复点旁的严格 pair 是目标数据库与配置的权威来源；全新卷或损坏
    # installed config 时也必须能自举。PostgreSQL Compose 仍应使用其
    # 带 pg_restore 的专用 postgres-restore service。
    exec pnpm db:restore "$@"
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
