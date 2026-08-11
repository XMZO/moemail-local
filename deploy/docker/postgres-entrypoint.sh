#!/bin/bash
set -Eeuo pipefail

data_directory=/var/lib/postgresql/data
version_file="$data_directory/PG_VERSION"
hba_file="$data_directory/pg_hba.conf"
expected_major=18
export PGDATA="$data_directory"

fail_incompatible_cluster() {
  local detected_path="$1"
  local detected_major="$2"

  printf 'Refusing to start PostgreSQL %s with the existing cluster at %s (PG_VERSION=%s).\n' \
    "$expected_major" "$detected_path" "$detected_major" >&2
  printf '%s\n' \
    'PostgreSQL major versions are not storage-compatible. The existing files were left untouched.' \
    'Create and export a paired logical backup with the old image, then follow the PostgreSQL 17 -> 18 migration runbook.' >&2
  exit 78
}

if [ -L "$version_file" ] || { [ -e "$version_file" ] && [ ! -f "$version_file" ]; }; then
  echo "Refusing to use a non-regular PostgreSQL version marker: $version_file" >&2
  exit 78
fi

if [ -s "$version_file" ]; then
  detected_major="$(cat -- "$version_file")"
  if [ "$detected_major" != "$expected_major" ]; then
    fail_incompatible_cluster "$data_directory" "$detected_major"
  fi
elif [ -d "$data_directory" ] \
  && find "$data_directory" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "Refusing to initialize over an incomplete PostgreSQL data directory: $data_directory" >&2
  echo 'Move it aside for investigation or restore a verified paired backup; no files were changed.' >&2
  exit 78
fi

if [ "$(id -u)" = "0" ]; then
  install -d -o postgres -g postgres -m 0700 "$data_directory"
  exec gosu postgres "$0" "$@"
fi

server_major="$(postgres --version | awk '{ print $3 }' | cut -d. -f1)"
if [ "$server_major" != "$expected_major" ]; then
  echo "PostgreSQL image/entrypoint major mismatch: expected $expected_major, found $server_major" >&2
  exit 70
fi

if [ ! -s "$version_file" ]; then
  initdb \
    --pgdata="$data_directory" \
    --username=moemail \
    --encoding=UTF8 \
    --auth-local=trust \
    --auth-host=trust

  cat >>"$data_directory/postgresql.conf" <<'EOF'
listen_addresses = '*'
password_encryption = 'scram-sha-256'
EOF

  pg_ctl --pgdata="$data_directory" --options="-c listen_addresses=''" --wait start
  createdb --username=moemail moemail
  pg_ctl --pgdata="$data_directory" --mode=fast --wait stop
fi

# The database service is attached only to Compose's internal database network
# and does not publish port 5432. initdb's generated host rules cover loopback
# only, so explicitly allow peer containers on that isolated network. Keep this
# outside the init block so volumes created by older images are repaired too.
if ! grep -Fqx '# moemail-compose-internal-trust' "$hba_file"; then
  cat >>"$hba_file" <<'EOF'
# moemail-compose-internal-trust
host all all 0.0.0.0/0 trust
host all all ::/0 trust
EOF
fi

if [ "${1:-}" = "postgres" ]; then
  shift
fi

exec postgres -D "$data_directory" "$@"
