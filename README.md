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

This repository is the local-first fork of [beilunyang/moemail](https://github.com/beilunyang/moemail). The Web/API runtime, configuration, database, scheduled maintenance, and backups run on your own Linux host. Cloudflare is only used as the optional inbound email routing layer: Email Routing sends messages to a small Email Worker, which forwards them to your public MoeMail HTTPS endpoint.

## Features

- One-file Docker Compose deployment; no local image build and no `.env` file.
- Native Linux `amd64` and `arm64` GHCR images built on matching GitHub-hosted runners, without QEMU emulation.
- SQLite, bundled PostgreSQL 17, or an external PostgreSQL 17/18 database.
- Browser-based first-run setup and one Emperor administrator account.
- Runtime YAML configuration with validation, hot reload, and last-known-good recovery.
- Temporary mailboxes, expiry and cleanup, role-based access, OpenAPI keys, webhooks, sharing, optional OAuth, and optional Resend delivery.
- Scheduled cleanup, database backups, monitoring, and encrypted-capable rclone off-site copies.
- CLI and MCP clients for automated and agent workflows.

## Production deployment

### Requirements

- A Linux `x86_64` or `aarch64` host with Docker Engine and Docker Compose v2.
- A host-installed reverse proxy such as Caddy or Nginx for public HTTPS.
- Public access to the three GHCR packages, or an authenticated `docker login ghcr.io` session.
- A Cloudflare-managed email domain only if you want to receive Internet email through Cloudflare Email Routing.

### 1. Download the versioned Compose file

Use the same release tag for the Compose file and all three images. Do not use `latest` for a production deployment.

```bash
set -euo pipefail
mkdir -p moemail
cd moemail
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/v0.16.0/compose.yaml \
  -o compose.yaml
docker compose config --quiet
docker compose up -d
docker compose ps
```

The Compose file pulls these multi-architecture images:

| Purpose | Image |
| --- | --- |
| Web/API and application jobs | `ghcr.io/xmzo/moemail-local:v0.16.0` |
| Bundled PostgreSQL 17 | `ghcr.io/xmzo/moemail-local-postgres:v0.16.0` |
| PostgreSQL 18 backup/restore tools | `ghcr.io/xmzo/moemail-local-postgres-tools:v0.16.0` |

The application listens only on `127.0.0.1:3000`. PostgreSQL is not published on the host.

### 2. Complete first-run setup

The setup token is created on the first request to the setup page. Request it once from the host, then read the token:

```bash
curl -fsS http://127.0.0.1:3000/en/setup >/dev/null
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'
```

Open the site through an SSH tunnel or your HTTPS reverse proxy and complete the setup wizard. It configures the public URL, database, first Emperor account, runtime secrets, and optional integrations.

Database choices:

- **SQLite:** keep the default `data/moemail.db` path.
- **Bundled PostgreSQL:** use `postgresql://moemail@postgres:5432/moemail`.
- **External PostgreSQL:** supply the provider URL and configure TLS separately in the wizard.

All application settings are stored in `data/config.yaml`; the application does not read deployment settings from environment variables.

### 3. Configure host Caddy

Caddy is deliberately not bundled in Compose. This host configuration preserves the application's request limits and replaces client-IP headers instead of trusting values supplied by the caller:

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

Set the same HTTPS origin as the public URL in the setup wizard, enable trusted proxy headers, then reload Caddy. Keep port 3000 bound to loopback and expose only ports 80/443 through the host firewall. A versioned copy with access-log rotation is available at [`deploy/local/Caddyfile`](deploy/local/Caddyfile).

### 4. Configure inbound email

Receiving email still requires Cloudflare Email Routing and an Email Worker. The data path is:

```text
Internet SMTP -> Cloudflare Email Routing -> Email Worker
              -> https://mail.example.com/api/internal/email -> local MoeMail database
```

The Worker must use the exact `email.ingestSecret` generated by the setup wizard. Direct forwarding and a more durable R2 + Queue mode are documented in the [local deployment guide](docs/local-deployment.zh-CN.md#6-cloudflare-email-worker).

## Persistent data and portability

Everything that must survive container or image removal is stored beside `compose.yaml`:

| Host path | Contents |
| --- | --- |
| `./data/` | `config.yaml`, LKG config, setup state, SQLite database and backups |
| `./data/postgres/` | Bundled PostgreSQL physical data |
| `./data/postgres-backups/` | PostgreSQL archives and paired configuration snapshots |

`docker compose down --rmi all` removes containers and images but leaves these bind-mounted files intact. Only deleting `./data` destroys local state.

For a cold, portable archive, stop all writers and preserve numeric ownership:

```bash
set -euo pipefail
docker compose --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-$(date -u +%Y%m%d%H%M%S).tar.gz" compose.yaml data
docker compose --profile '*' start
```

Use the logical backup and independent restore procedures for regular operations and recovery drills; do not copy a live PostgreSQL physical directory. See [Backup and restore](docs/local-deployment.zh-CN.md#8-备份恢复与异地同步).

## Optional Compose profiles

The default `docker compose up -d` starts storage initialization, bundled PostgreSQL, and the Web/API service. Additional services are opt-in:

| Profile | Purpose | Typical command |
| --- | --- | --- |
| `maintenance` | One-shot cleanup and database backups | SQLite: `docker compose --profile maintenance run --rm backup`; PostgreSQL: `docker compose --profile maintenance run --rm postgres-backup` |
| `scheduler` | Continuous cleanup and backup scheduling | `docker compose --profile scheduler up -d scheduler postgres-backup-scheduler` |
| `monitoring` | Runtime and storage monitoring | `docker compose --profile monitoring up -d monitor` |
| `offsite` | Scheduled rclone copies | `docker compose --profile offsite up -d offsite-backup` |
| `restore` | Explicit PostgreSQL recovery tooling | Follow the recovery runbook before running it |

Do not run both the Compose scheduler and the host systemd scheduler. Configure monitoring, backup retention, and off-site credentials in the WebUI runtime configuration before enabling their profiles.

## Upgrade and security checklist

1. Create and copy a verified database + `config.yaml.lkg` backup outside the deployment directory.
2. Download the new release's `compose.yaml` and pin all three images to the same immutable release tag (or digests).
3. Run `docker compose config --quiet`, `docker compose pull`, and `docker compose up -d`.
4. Check `docker compose ps`, health status, login, mail ingestion, and backup output before considering the upgrade complete.
5. Regularly restore into a separate directory/project; changing only the Compose project name does not isolate relative bind mounts.

Keep these production boundaries in place:

- Never publish the bundled PostgreSQL port; its internal trust authentication is intended only for the isolated Compose network.
- Protect `data/config.yaml`, `data/config.yaml.lkg`, database files, and backups as secrets. Never commit `data/`.
- Keep the app on loopback behind HTTPS, use strong administrator credentials, and enable only required OAuth, webhook, Resend, or off-site integrations.
- Prefer version tags or digests over `latest`, and take a recoverable backup before every upgrade.
- Review the full [deployment and operations guide](docs/local-deployment.zh-CN.md) before serving production traffic.

## Development and validation

```bash
git clone https://github.com/XMZO/moemail-local.git
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

MoeMail Local derives from [beilunyang/moemail](https://github.com/beilunyang/moemail). Local-first changes are maintained in [XMZO/moemail-local](https://github.com/XMZO/moemail-local); upstream features and security fixes should be reviewed and merged deliberately because the runtime and deployment models differ.

Licensed under the [MIT License](LICENSE).
