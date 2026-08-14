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

This repository is the local-first fork of [beilunyang/moemail](https://github.com/beilunyang/moemail). The Web/API runtime, configuration, database, mail policies, scheduled maintenance, and backups run on your own Linux host. Each mail domain independently chooses Cloudflare Email Worker, Mailu, or an external mailbox over IMAP for inbound delivery, and Mailu, Resend, external SMTP, or disabled outbound delivery.

## Features

- Two standalone Docker Compose choices: a lightweight SQLite deployment and a bundled PostgreSQL deployment.
- Native Linux `amd64` and `arm64` GHCR images built on matching GitHub-hosted runners without QEMU emulation.
- Browser-based first-run setup and one Emperor administrator account.
- Complete visual and raw-YAML runtime editors with per-field reset, validation, hot reload, and last-known-good recovery.
- Independent Worker/Mailu/IMAP inbound and Mailu/Resend/SMTP outbound policy per domain; ordinary provider credentials stay per-domain, while the optional Mailu integration deliberately uses one managed collector across its selected domains.
- Per-role and per-user permissions, including optional private multi-recipient delivery, plus mailbox, lifetime, send/receive, and message-size quotas. Emperor access is always complete and cannot be overridden.
- Temporary mailboxes, expiry and cleanup, API keys, webhooks, sharing, optional OAuth, Turnstile, and a global font setting.
- Scheduled cleanup, database backups, monitoring, and rclone off-site copies.
- CLI and MCP clients for automated and agent workflows.

## Choose exactly one deployment directory

| Deployment | Repository file | Start command |
| --- | --- | --- |
| SQLite | `sqlite/docker-compose.yml` | Run `docker compose up -d` inside the SQLite deployment directory |
| Bundled PostgreSQL 18 | `postgres/docker-compose.yml` | Run `docker compose up -d` inside the PostgreSQL deployment directory |

Each directory contains one complete, standalone `docker-compose.yml`. Enter exactly one deployment directory and use plain `docker compose ...` commands. **Do not combine the files** with multiple `-f` arguments. Each directory creates its own adjacent `data/`, so copying or archiving that directory keeps its Compose definition and state together. Switching databases requires a planned migration, not Compose overlaying.

Neither variant uses `.env`, Compose application environment variables, a local image build, or a bundled Caddy container. Both bind Web to `127.0.0.1:3000` and keep all state under `./data`.

If you are upgrading from the old `v0.16.1` single-file deployment, stop it with its original filename and move that file aside before downloading exactly one new variant:

```bash
docker compose -f compose.yaml --profile '*' down
mv compose.yaml compose.v0.16.1.yaml
```

Do not add `-v`; the bind-mounted `./data` directory must be preserved. Leaving `compose.yaml` in place is unsafe because a plain `docker compose` may continue selecting the legacy file instead of `docker-compose.yml`.

## Production deployment

### Requirements

- A Linux `x86_64` or `aarch64` host with Docker Engine and Docker Compose v2.
- A host-installed reverse proxy such as Caddy or Nginx for public HTTPS.
- Public access to the required GHCR packages, or an authenticated `docker login ghcr.io` session.
- Cloudflare Email Routing for Worker delivery, or an external provider that supports catch-all delivery and preserves the original-recipient header for IMAP import.

### Option A: SQLite

SQLite is the smallest deployment. Its default `up -d` pulls only the standalone Web image;
maintenance profiles pull the matching on-demand tools tag later:

- `ghcr.io/xmzo/moemail-local:latest`
- `ghcr.io/xmzo/moemail-local:latest-tools` (only for maintenance profiles)

```bash
set -euo pipefail
mkdir -p moemail-sqlite
cd moemail-sqlite
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/master/sqlite/docker-compose.yml \
  -o docker-compose.yml
docker compose config --quiet
docker compose up -d
docker compose ps
```

Keep the setup wizard's default database path, `data/moemail.db`.

### Option B: bundled PostgreSQL

The PostgreSQL default starts the standalone Web image and PostgreSQL 18. Maintenance
profiles pull the two tools images only when requested:

- `ghcr.io/xmzo/moemail-local:latest`
- `ghcr.io/xmzo/moemail-local:latest-tools` (application maintenance profiles)
- `ghcr.io/xmzo/moemail-local-postgres:latest`
- `ghcr.io/xmzo/moemail-local-postgres-tools:latest` (PostgreSQL backup/restore profiles)

```bash
set -euo pipefail
mkdir -p moemail-postgres
cd moemail-postgres
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/master/postgres/docker-compose.yml \
  -o docker-compose.yml
docker compose config --quiet
docker compose up -d
docker compose ps
```

Existing PostgreSQL deployments can switch filenames once without changing containers or data. The command first proves that the selected old file really contains the `postgres` service, and preserves conflicting defaults instead of deleting them:

```bash
set -euo pipefail
test ! -e docker-compose.yml
if [ -f compose.postgres.yml ]; then
  legacy_compose=compose.postgres.yml
elif [ -f compose.yml ]; then
  legacy_compose=compose.yml
else
  echo "No legacy PostgreSQL Compose file found" >&2
  exit 1
fi
docker compose -f "$legacy_compose" config --services | grep -qx postgres
for old_default in compose.yml compose.yaml docker-compose.yaml; do
  if [ "$old_default" != "$legacy_compose" ] && [ -e "$old_default" ]; then
    mv "$old_default" "$old_default.disabled"
  fi
done
mv "$legacy_compose" docker-compose.yml
docker compose config --quiet
docker compose up -d
```

Select PostgreSQL in the setup wizard and use:

```text
postgresql://moemail@postgres:5432/moemail
```

The bundled database uses trust authentication only on its isolated Compose network and does not publish port 5432.

### Complete first-run setup

First open the site through an SSH tunnel or your HTTPS reverse proxy. Loading the setup page creates the one-time setup token. Both deployments then use the same command:

```bash
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'
```

Complete the wizard to configure the public URL, database, first Emperor account, runtime secrets, and optional integrations. After signing in, open **Profile → Domain mail** first, replace the example domain, and select inbound/outbound delivery for each domain. Access policies, the complete runtime config, and the global font are also under Profile. Settings are stored in `data/config.yaml` or the selected database's `site_config`; the application does not read deployment settings from environment variables.

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

Set the same HTTPS origin as the public URL in the setup wizard, enable trusted proxy headers, and reload Caddy. Keep port 3000 on loopback and expose only 80/443 for Web. IMAP and SMTP are outbound connections from the app to external providers; neither needs a host port or Caddy proxy. A versioned example with access-log rotation is available at [`deploy/local/Caddyfile`](deploy/local/Caddyfile).

## Inbound email

Choose one inbound method for each domain in **Profile → Domain mail**. Do not import the same domain through both Worker and external IMAP.

### Option A: Cloudflare Email Worker

```text
Internet SMTP -> Cloudflare Email Routing -> Email Worker
              -> https://mail.example.com/api/internal/email -> local MoeMail database
```

The Worker must use the exact `email.ingestSecret` generated by the setup wizard. Start with direct forwarding. You can deploy it from a computer with Git, Node.js 22, and Corepack; it does not need to run on the MoeMail server. A Compose-only deployment directory does not contain the Worker source, so these commands fetch the complete matching release:

```bash
git clone --branch v0.19.1 --depth 1 https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm exec wrangler login
cp wrangler.email.example.json wrangler.email.json
```

Change only the existing `EMAIL_INGEST_URL` in `wrangler.email.json` to the public MoeMail HTTPS endpoint. The following is a fragment; do not replace the complete file with it:

```json
{
  "vars": {
    "EMAIL_INGEST_URL": "https://mail.example.com/api/internal/email"
  }
}
```

Copy `email.ingestSecret` from the setup success page or the Emperor account's Runtime Configuration panel. Paste it only at the Wrangler prompt below; never store it in the JSON file or commit it to Git:

```bash
pnpm exec wrangler secret put EMAIL_INGEST_SECRET --config wrangler.email.json
pnpm deploy:email
```

If Wrangler asks to create `email-receiver-worker` during the first `secret put`, confirm it. After deployment, enable Email Routing for the domain in Cloudflare and apply its required MX records. Then open **Email Routing → Routing rules**, set the catch-all or a specific address to **Send to a Worker**, and select `email-receiver-worker`. Send a test message while watching the live logs:

```bash
pnpm exec wrangler tail --config wrangler.email.json
```

`EMAIL_INGEST_URL` must be the complete public HTTPS `/api/internal/email` endpoint, not `localhost` or a Compose service name. Direct forwarding does not provide durable retry while the host is offline. For R2 + Queue buffering, use the [durable mode in the deployment guide](docs/local-deployment.zh-CN.md#62-r2--queue-耐久模式).

### Option B: Mailu-managed inbound and outbound

MoeMail can coordinate an existing Mailu installation without modifying Mailu. In Mailu, enable the REST API (`API=true`), expose its configured `WEB_API` path over HTTPS, and set a strong `API_TOKEN`. In **Profile → Domain mail → Mailu integration**, enter the complete v1 base URL (normally `https://mail.example.com/api/v1`), API token, IMAP/SMTP endpoints, and two distinct service-account addresses with strong generated passwords. The service-account domains and every domain selected for Mailu must already exist in Mailu.

Use **Discover domains** to review Mailu domains, explicitly add the wanted domains to the MoeMail draft, choose Mailu for inbound and/or outbound, save, then run **Reconcile now**. MoeMail creates only objects carrying its integration ownership marker:

- an IMAP-enabled collector with `allow_spoofing=false`;
- a disabled-login catch-all forwarding account that cannot authenticate to SMTP;
- one exact alias for each active inbound address and each currently authorized sender: only a mailbox whose owner has MoeMail send permission and domain send access points to the collector; inbound-only or send-denied addresses point to the disabled forwarding account;
- optionally `%@domain` catch-all aliases pointing to the forwarding account.

Mailu's Sieve-generated `Delivered-To` is treated as the true SMTP envelope recipient; MIME `To`/`Cc` is never used for routing. Real-time `IMAP IDLE` receiving is enabled by default: Mailu notifies MoeMail over the long-lived connection as soon as a message reaches the collector, disconnections reconnect with exponential backoff, and a configurable 15–86400 second full poll covers missed notifications and downtime. Servers without IDLE safely fall back to polling. SMTP sending requires both an active mailbox owned by the caller and its exact managed alias, so the catch-all never authorizes arbitrary From addresses. Password rotation is available only through the dedicated random-rotation buttons. By default, upstream messages are deleted 24 hours after MoeMail durably commits them; choose Keep, Archive, or a shorter delay if preferred. Deletion/move is queued only for committed messages or proven duplicates, requires safe UID-scoped IMAP capabilities, and leaves rejected or unknown-recipient mail upstream.

Disabling the integration immediately pauses IMAP real-time receiving and fallback polling, SMTP use, and automatic reconciliation, but intentionally does not delete remote Mailu objects. First switch every affected domain away from Mailu and run one final reconciliation if you want MoeMail-owned aliases removed. Because Mailu uses an exact alias both for SMTP sender-login authorization and inbound routing, an outbound-only MoeMail domain may still deliver unsolicited inbound mail into the collector; select Mailu inbound too, or monitor/clean that collector explicitly. MoeMail's supported production topology is one Web instance; the IMAP collector additionally uses a database lease to prevent overlapping notifications and polling workers.

Mailu is a separate mail-server deployment: configure its MX, TLS, DKIM/SPF/DMARC, spam controls, storage, backups, and API network access according to Mailu's own documentation. Restrict the Mailu API to MoeMail's host or a private network whenever possible. The Mailu API token and service passwords are stored in MoeMail's selected database and therefore enter its backups.

### Option C: external mailbox over IMAP

Configure catch-all delivery (or equivalent aliases) at the external provider so every address for the domain lands in one mailbox. The provider must preserve and sanitize the original envelope recipient in `X-Original-To`, `Envelope-To`, `Delivered-To`, or a similar delivery-trace header. Sender-controlled MIME `To` is deliberately not accepted. A conventional mailbox that receives only one fixed address or strips envelope information cannot reconstruct MoeMail temporary addresses.

Select External mailbox IMAP for the domain in the WebUI, enter the IMAP host, port, TLS mode, username, password or app password, and mailbox, then test the connection and save. By default, only mail arriving after the configuration is saved is imported; initial unread-message import is optional. The poller runs inside the Web process and needs no Compose profile.

Polling uses read-only `EXAMINE` and PEEK operations, so it never marks messages read, moves them, or deletes them upstream. Progress is persisted by `UIDVALIDITY + UID`, while raw RFC822 content provides application-level deduplication. Tail the Web container for status:

```bash
docker compose logs -f moemail
```

## Outbound email

For each domain, choose **Mailu integration**, **Resend**, **External SMTP**, or **Disabled** under **Profile → Domain mail**. Resend uses a key dedicated to that domain. External SMTP accepts the provider host, port, TLS/STARTTLS mode, username/password or app password, optional From name, and an `Auto`, `PLAIN`, or `LOGIN` authentication preference. Keep `Auto` for most providers; select `LOGIN` for Microsoft/Outlook or another provider only when it still permits password-based SMTP AUTH and rejects automatic negotiation. OAuth-only Microsoft 365 tenants require an OAuth-capable relay/provider and are not made compatible by choosing `LOGIN`. Use **Test SMTP connection** to verify transport and authentication without sending a message. The visible sender remains the selected MoeMail address, so the provider must authorize that domain/address.

Normal multi-recipient delivery puts every address in the same `To` header, so recipients can see one another. Users granted **Hide recipients with separate delivery** can enable the switch in the composer, or API clients can send `privateRecipients: true`; MoeMail then submits one message per unique recipient with no other recipient address in its headers. Both modes consume quota by unique recipient count.

IMAP, SMTP, and Resend credentials are stored in the selected database and are included in database backups. Protect backups as secrets. Delivery-provider limits, DKIM/SPF/DMARC, bounces, and abuse controls remain the responsibility of that external provider.

## Persistent data and portability

Both variants keep state beside their selected Compose file:

| Host path | Contents |
| --- | --- |
| `./data/` | `config.yaml`, LKG config, setup state, SQLite database and SQLite backups |
| `./data/postgres/` | Bundled PostgreSQL physical data; PostgreSQL variant only |
| `./data/postgres-backups/` | PostgreSQL archives and paired configuration snapshots; PostgreSQL variant only |

Removing containers or images leaves these bind-mounted files intact. Only deleting `./data` destroys local state.

For a cold portable archive, run this inside the selected deployment directory:

```bash
set -euo pipefail
docker compose --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-$(date -u +%Y%m%d%H%M%S).tar.gz" docker-compose.yml data
docker compose --profile '*' start
```

Use logical backups and independent restore procedures for routine recovery drills; never copy a live PostgreSQL physical directory. See [Backup and restore](docs/local-deployment.zh-CN.md#8-备份恢复与异地同步).

## Optional profiles

SQLite commands use the default file:

```bash
docker compose --profile maintenance run --rm --no-deps cleanup
docker compose --profile maintenance run --rm --no-deps backup
docker compose --profile maintenance run --rm --no-deps verify
docker compose --profile scheduler up -d scheduler
docker compose --profile monitoring up -d monitor
docker compose --profile offsite up -d offsite-backup
```

PostgreSQL uses the same default filename and therefore the same short command form:

```bash
docker compose --profile maintenance run --rm postgres-backup
docker compose --profile maintenance run --rm --no-deps verify
docker compose --profile scheduler up -d scheduler postgres-backup-scheduler
docker compose --profile monitoring up -d monitor
docker compose --profile offsite up -d offsite-backup
```

Do not run both the Compose scheduler and the host systemd scheduler. Configure monitoring, retention, and off-site credentials in the WebUI before enabling those profiles. PostgreSQL restore is intentionally explicit; follow the recovery runbook instead of improvising a command.

## Upgrade and security checklist

1. Record whether the deployment directory came from `sqlite/` or `postgres/`; never change variants as part of a routine image upgrade.
2. Create and export a verified database + `config.yaml.lkg` pair outside `./data` using the current version.
3. When the Compose structure changes, download the same filename from `master` to a temporary file and run `docker compose -f <temporary-file> config --quiet`; keep the existing file for an image-only update.
4. Download the matching repository file as `docker-compose.yml.next`, validate it, replace the installed `docker-compose.yml`, then run plain `docker compose pull`, `up -d`, `ps`, database verification, login, ingestion, and backup checks.
5. Regularly restore into a separate directory/project. Changing only the Compose project name does not isolate relative bind mounts.

Keep these production boundaries in place:

- Never combine the two Compose files or publish the bundled PostgreSQL port.
- Protect `data/config.yaml`, `data/config.yaml.lkg`, database files, and backups as secrets. Never commit `data/`.
- Keep the app on loopback behind HTTPS and enable only the integrations you need.
- Compose intentionally tracks `latest`. Pull only after the complete image publishing workflow succeeds, and take a recoverable backup first. For rollback, pin every image in the selected variant to the same previous tag or digest.
- Review the full [deployment and operations guide](docs/local-deployment.zh-CN.md) before serving production traffic.

## Development and validation

```bash
git clone --branch v0.19.1 --depth 1 https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit --incremental false
pnpm validate:no-local-env
pnpm validate:deployment
pnpm validate:maintenance-bundle
pnpm validate:email-worker
pnpm validate:mail-policies
pnpm validate:send-quota
pnpm validate:policy-migrations
pnpm validate:imap-inbound
pnpm validate:mailu
pnpm validate:runtime-fields
pnpm validate:i18n
```

Start a development server with `pnpm dev`. The local runtime still needs its first-run setup before application routes are usable.

Useful references:

- [Detailed local deployment, Email Worker, backup, restore, migration, and systemd guide](docs/local-deployment.zh-CN.md)
- [Validation record and remaining environment acceptance checks](docs/local-validation.zh-CN.md)
- [Configuration roadmap for future administrator options](docs/configurability-roadmap.zh-CN.md)
- [CLI package](packages/cli/README.md)
- [MCP package](packages/mcp/README.md)

## Upstream and license

MoeMail Local derives from [beilunyang/moemail](https://github.com/beilunyang/moemail). Local-first changes are maintained in [XMZO/moemail-local](https://github.com/XMZO/moemail-local); upstream changes should be reviewed and merged deliberately because the runtime and deployment models differ.

Licensed under the [MIT License](LICENSE).
