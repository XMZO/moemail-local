#!/bin/bash
set -Eeuo pipefail

data_root=/var/lib/postgresql
data_directory=/var/lib/postgresql/18/docker
hba_file="$data_directory/pg_hba.conf"

if [ "$(id -u)" = "0" ]; then
  install -d -o postgres -g postgres -m 0700 "$data_root" "$data_directory"
  exec gosu postgres "$0" "$@"
fi

if [ ! -s "$data_directory/PG_VERSION" ]; then
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
