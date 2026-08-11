<p align="center">
  <img src="public/icons/icon-192x192.png" alt="MoeMail Logo" width="100" height="100">
  <h1 align="center">MoeMail Local</h1>
</p>

<p align="center">
  A local-first, self-hosted temporary email service powered by Next.js and SQLite/PostgreSQL.
</p>

<p align="center">
  <span>English</span> |
  <a href="./README.zh-CN.md">简体中文</a>
</p>

This repository is the local-first fork of [beilunyang/moemail](https://github.com/beilunyang/moemail). The Web/API runtime, configuration, database, scheduled maintenance, and backups run on your own Linux host. Cloudflare is only the optional inbound email routing layer: Email Routing sends messages to an Email Worker, which forwards them to your public MoeMail HTTPS endpoint.

## Features

- Two standalone Docker Compose choices: a lightweight SQLite deployment and a bundled PostgreSQL deployment.
- Native Linux `amd64` and `arm64` GHCR images built on matching GitHub-hosted runners without QEMU emulation.
- Browser-based first-run setup and one Emperor administrator account.
- Runtime YAML configuration with validation, hot reload, and last-known-good recovery.
- Temporary mailboxes, expiry and cleanup, role-based access, OpenAPI keys, webhooks, sharing, optional OAuth, and optional Resend delivery.
- Scheduled cleanup, database backups, monitoring, and rclone off-site copies.
- CLI and MCP clients for automated and agent workflows.

## Choose exactly one Compose file

| Deployment | File | Start command | Images pulled |
| --- | --- | --- | --- |
| SQLite | `compose.yml` | `docker compose up -d` | `ghcr.io/xmzo/moemail-local:v0.16.2` |
| Bundled PostgreSQL 17 | `compose.postgres.yml` | `docker compose -f compose.postgres.yml up -d` | App, PostgreSQL, and PostgreSQL tools images at `v0.16.2` |

Both files are complete, standalone deployments. **Do not combine them** with multiple `-f` arguments, and do not run both against the same `./data` directory. They use the same project name, loopback port, and persistent paths. Switching databases requires a planned migration, not Compose overlaying.

Neither variant uses `.env`, Compose application environment variables, a local image build, or a bundled Caddy container. Both bind Web to `127.0.0.1:3000` and keep all state under `./data`.

If you are upgrading from the old `v0.16.1` single-file deployment, stop it with its original filename and move that file aside before downloading exactly one new variant:

```bash
docker compose -f compose.yaml --profile '*' down
mv compose.yaml compose.v0.16.1.yaml
```

Do not add `-v`; the bind-mounted `./data` directory must be preserved. Leaving `compose.yaml` in place is unsafe because a plain `docker compose` may continue selecting the legacy file instead of `compose.yml`.

## Production deployment

### Requirements

- A Linux `x86_64` or `aarch64` host with Docker Engine and Docker Compose v2.
- A host-installed reverse proxy such as Caddy or Nginx for public HTTPS.
- Public access to the required GHCR packages, or an authenticated `docker login ghcr.io` session.
- A Cloudflare-managed email domain only if you want to receive Internet email through Cloudflare Email Routing.

### Option A: SQLite

SQLite is the smallest deployment and pulls only the application image:

```bash
set -euo pipefail
mkdir -p moemail
cd moemail
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/v0.16.2/compose.yml \
  -o compose.yml
docker compose config --quiet
docker compose up -d
docker compose ps
```

Keep the setup wizard's default database path, `data/moemail.db`.

### Option B: bundled PostgreSQL

The PostgreSQL deployment pulls these three images:

- `ghcr.io/xmzo/moemail-local:v0.16.2`
- `ghcr.io/xmzo/moemail-local-postgres:v0.16.2`
- `ghcr.io/xmzo/moemail-local-postgres-tools:v0.16.2`

```bash
set -euo pipefail
mkdir -p moemail
cd moemail
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/v0.16.2/compose.postgres.yml \
  -o compose.postgres.yml
docker compose -f compose.postgres.yml config --quiet
docker compose -f compose.postgres.yml up -d
docker compose -f compose.postgres.yml ps
```

Select PostgreSQL in the setup wizard and use:

```text
postgresql://moemail@postgres:5432/moemail
```

The bundled database uses trust authentication only on its isolated Compose network and does not publish port 5432.

### Complete first-run setup

First open the site through an SSH tunnel or your HTTPS reverse proxy. Loading the setup page creates the one-time setup token. Then read it with the command matching your chosen deployment:

```bash
# SQLite
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'

# PostgreSQL
docker compose -f compose.postgres.yml \
  exec -T moemail sh -c 'cat /app/data/setup-token'
```

Complete the wizard to configure the public URL, database, first Emperor account, runtime secrets, and optional integrations. All application settings are stored in `data/config.yaml`; the application does not read deployment settings from environment variables.

## Host Caddy

Caddy is deliberately not bundled in either Compose file. This host configuration preserves the application's request limits and replaces client-IP headers instead of trusting caller-supplied values:

```caddyfile
mail.example.com {
    @email_ingest path /api/internal/email
    handle @email_ingest {
        request_body {
            max_size 27MB
        }
        reverse_proxy 127.0.0.1:3000 {
            header_up X-MoeMail-Client-IP {remote_host}
            header_up -CF-Connecting-IP
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
        }
    }

    handle {
        request_body {
            max_size 1MB
        }
        reverse_proxy 127.0.0.1:3000 {
            header_up X-MoeMail-Client-IP {remote_host}
            header_up -CF-Connecting-IP
            header_up X-Real-IP {remote_host}
            header_up X-Forwarded-For {remote_host}
        }
    }
}
```

Set the same HTTPS origin as the public URL in the setup wizard, enable trusted proxy headers, and reload Caddy. Keep port 3000 on loopback and expose only ports 80/443 through the host firewall. A versioned example with access-log rotation is available at [`deploy/local/Caddyfile`](deploy/local/Caddyfile).

## Inbound email

Receiving email still requires Cloudflare Email Routing and an Email Worker:

```text
Internet SMTP -> Cloudflare Email Routing -> Email Worker
              -> https://mail.example.com/api/internal/email -> local MoeMail database
```

The Worker must use the exact `email.ingestSecret` generated by the setup wizard. Direct forwarding and the durable R2 + Queue mode are documented in the [Email Worker section](docs/local-deployment.zh-CN.md#6-cloudflare-email-worker).

## Persistent data and portability

Both variants keep state beside their selected Compose file:

| Host path | Contents |
| --- | --- |
| `./data/` | `config.yaml`, LKG config, setup state, SQLite database and SQLite backups |
| `./data/postgres/` | Bundled PostgreSQL physical data; PostgreSQL variant only |
| `./data/postgres-backups/` | PostgreSQL archives and paired configuration snapshots; PostgreSQL variant only |

Removing containers or images leaves these bind-mounted files intact. Only deleting `./data` destroys local state.

For a cold portable archive, set `compose_file` to the one file you actually deployed:

```bash
set -euo pipefail
compose_file=compose.yml
# PostgreSQL deployment: compose_file=compose.postgres.yml
docker compose -f "$compose_file" --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-$(date -u +%Y%m%d%H%M%S).tar.gz" "$compose_file" data
docker compose -f "$compose_file" --profile '*' start
```

Use logical backups and independent restore procedures for routine recovery drills; never copy a live PostgreSQL physical directory. See [Backup and restore](docs/local-deployment.zh-CN.md#8-备份恢复与异地同步).

## Optional profiles

SQLite commands use the default file:

```bash
docker compose --profile maintenance run --rm --no-deps cleanup
docker compose --profile maintenance run --rm --no-deps backup
docker compose --profile scheduler up -d scheduler
docker compose --profile monitoring up -d monitor
docker compose --profile offsite up -d offsite-backup
```

PostgreSQL commands always identify its standalone file:

```bash
docker compose -f compose.postgres.yml --profile maintenance \
  run --rm postgres-backup
docker compose -f compose.postgres.yml --profile scheduler \
  up -d scheduler postgres-backup-scheduler
docker compose -f compose.postgres.yml --profile monitoring up -d monitor
docker compose -f compose.postgres.yml --profile offsite up -d offsite-backup
```

Do not run both the Compose scheduler and the host systemd scheduler. Configure monitoring, retention, and off-site credentials in the WebUI before enabling those profiles. PostgreSQL restore is intentionally explicit; follow the recovery runbook instead of improvising a command.

## Upgrade and security checklist

1. Record whether the deployment uses `compose.yml` or `compose.postgres.yml`; never change variants as part of a routine image upgrade.
2. Create and export a verified database + `config.yaml.lkg` pair outside `./data` using the current version.
3. Download the same filename from the target release to a temporary file and run `docker compose -f <temporary-file> config --quiet`.
4. Replace only the selected Compose file, then run `pull`, `up -d`, `ps`, database verification, login, ingestion, and backup checks with that file.
5. Regularly restore into a separate directory/project. Changing only the Compose project name does not isolate relative bind mounts.

Keep these production boundaries in place:

- Never combine the two Compose files or publish the bundled PostgreSQL port.
- Protect `data/config.yaml`, `data/config.yaml.lkg`, database files, and backups as secrets. Never commit `data/`.
- Keep the app on loopback behind HTTPS and enable only the integrations you need.
- Use version tags or digests rather than `latest`, and take a recoverable backup before every upgrade.
- Review the full [deployment and operations guide](docs/local-deployment.zh-CN.md) before serving production traffic.

## Development and validation

```bash
git clone --branch v0.16.2 --depth 1 https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit --incremental false
pnpm validate:no-local-env
pnpm validate:deployment
```

Start a development server with `pnpm dev`. The local runtime still needs its first-run setup before application routes are usable.

Useful references:

- [Detailed local deployment, Email Worker, backup, restore, migration, and systemd guide](docs/local-deployment.zh-CN.md)
- [Validation record and remaining environment acceptance checks](docs/local-validation.zh-CN.md)
- [CLI package](packages/cli/README.md)
- [MCP package](packages/mcp/README.md)

## Upstream and license

MoeMail Local derives from [beilunyang/moemail](https://github.com/beilunyang/moemail). Local-first changes are maintained in [XMZO/moemail-local](https://github.com/XMZO/moemail-local); upstream changes should be reviewed and merged deliberately because the runtime and deployment models differ.

Licensed under the [MIT License](LICENSE).
