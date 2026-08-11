
<p align="center">
  <img src="public/icons/icon-192x192.png" alt="MoeMail Logo" width="100" height="100">
  <h1 align="center">MoeMail</h1>
</p>

<p align="center">
  A cute local-first temporary email service using Next.js Node, SQLite/PostgreSQL, and Cloudflare Email Routing 🎉
</p>

<p align="center">
  <span>English</span> | 
  <a href="./README.zh-CN.md">简体中文</a>
</p>

> This fork supports primary local deployment with Next.js Node production and SQLite or PostgreSQL, while Cloudflare only receives and forwards email. See the [local deployment guide](docs/local-deployment.zh-CN.md) and [validation record](docs/local-validation.zh-CN.md). The original Cloudflare workflow below remains available for upstream synchronization and rollback.

<p align="center">
  <a href="https://www.producthunt.com/products/moemail?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-moemail" target="_blank" rel="noopener noreferrer"><img alt="MoeMail - OpenAPI‑first temp email, hosted &amp; ready | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1078475&amp;theme=light&amp;t=1770964043604"></a>
</p>

<p align="center">
  <a href="#live-demo">Live Demo</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#features">Features</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#local-run">Local Run</a> •
  <a href="docs/local-deployment.zh-CN.md">Local Deployment</a> •
  <a href="#email-domain-configuration">Email Domain Config</a> •
  <a href="#permission-system">Permission System</a> •
  <a href="#system-settings">System Settings</a> •
  <a href="#sending-emails">Sending Emails</a> •
  <a href="#webhook-integration">Webhook Integration</a> •
  <a href="#openapi">OpenAPI</a> •
  <a href="#cli-tool">CLI Tool</a> •
  <a href="#mcp-server">MCP Server</a> •
  <a href="#runtime-configuration">Runtime Configuration</a> •
  <a href="#github-oauth-app-configuration">Github OAuth Config</a> •
  <a href="#google-oauth-app-configuration">Google OAuth Config</a> •
  <a href="#contribution">Contribution</a> •
  <a href="#license">License</a> •
  <a href="#community">Community</a> •
  <a href="#support">Support</a>
</p>

## Live Demo
[https://moemail.app](https://moemail.app)

![Home](https://pic.otaku.ren/20241209/AQADwsUxG9k1uVZ-.jpg "Home")

![Mailbox](https://pic.otaku.ren/20241209/AQADw8UxG9k1uVZ-.jpg "Mailbox")

![Profile](https://pic.otaku.ren/20241227/AQADVsIxG7OzcFd-.jpg "Profile")

## Documentation
**Full Documentation**: [https://docs.moemail.app](https://docs.moemail.app)

The documentation site contains detailed usage guides, API documentation, deployment tutorials, and other complete information.

## Features

- 🔒 **Privacy Protection**: Protect your real email address from spam and unnecessary subscriptions
- ⚡ **Real-time Receipt**: Automatic polling, receive email notifications instantly
- ⏱️ **Flexible Validity**: Supports 1 hour, 24 hours, 3 days, or permanent validity
- 🎨 **Theme Switching**: Supports light and dark modes
- 📱 **Responsive Design**: Perfectly adapted for desktop and mobile devices
- 🔄 **Auto Cleanup**: Automatically cleans up expired mailboxes and emails
- 📱 **PWA Support**: Installable, with static-only precaching and no offline caching of account pages or API data
- 🏠 **Local-first Self-hosting**: Run Web/API on Next.js Node with SQLite or PostgreSQL
- 🎉 **Cute UI**: Simple and cute UI interface
- 📤 **Sending Function**: Support sending emails using temporary addresses, based on Resend service
- 🔔 **Webhook Notification**: Support receiving new email notifications via webhook
- 🛡️ **Permission System**: Role-based access control system
- 🔑 **OpenAPI**: Support accessing OpenAPI via API Key
- 🤖 **Agent-first CLI**: CLI tool designed for AI agents to automate email workflows
- 🌍 **Multi-language Support**: Supports Chinese and English interfaces, freely switchable

## Tech Stack

- **Framework**: [Next.js](https://nextjs.org/) (App Router)
- **Platform**: Local Next.js Node production; Cloudflare Pages assets remain for rollback
- **Database**: Local SQLite (default) or PostgreSQL; D1 import/rollback tooling remains
- **Authentication**: [NextAuth](https://authjs.dev/getting-started/installation?framework=Next.js) with GitHub/Google Login
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **UI Components**: Custom components based on [Radix UI](https://www.radix-ui.com/)
- **Email Handling**: [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/)
- **Type Safety**: [TypeScript](https://www.typescriptlang.org/)
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/)
- **Internationalization**: [next-intl](https://next-intl-docs.vercel.app/)

## Local Run

```bash
git clone https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start --hostname 127.0.0.1 --port 3000
```

Open `http://localhost:3000`, then copy the one-time setup token from `data/setup-token` (or the service log produced after opening the wizard), and finish the WebUI wizard. The wizard configures the public URL, SQLite or PostgreSQL, the first Emperor account, optional OAuth, and advanced maintenance/backup settings; it then migrates the selected database and writes `data/config.yaml`. Runtime secrets are generated locally. No `.env` file or application environment variables are used.

When a direct production run switches from the bootstrap SQLite driver to PostgreSQL, the process exits successfully after setup so a supervisor can restart it. Without Docker or systemd, run the same `pnpm start --hostname 127.0.0.1 --port 3000` command again.

After setup, the Emperor can edit the complete YAML in **Profile → Runtime Configuration**, or an operator can edit `data/config.yaml` directly. Valid changes are applied at runtime; an invalid YAML, schema value, or database target is rejected while the previous working configuration remains active. See the [local deployment guide](docs/local-deployment.zh-CN.md) and [validation record](docs/local-validation.zh-CN.md) for Docker, PostgreSQL, Email Worker, backup, and operational details.

> The Wrangler/D1 workflow below is archived upstream documentation. It only applies to the fixed Cloudflare baseline worktree recorded in `plan.md`, not this local-first working tree. Tag pushes no longer trigger it.

## Archived Upstream Cloudflare Workflow

### Prerequisites

- Node.js 18+
- Pnpm
- Wrangler CLI
- Cloudflare Account

### Installation

1. Clone the repository:
```bash
git clone https://github.com/XMZO/moemail-local.git
cd moemail-local
git worktree add ../moemail-cloudflare-baseline 6c19aefc71ca60bc194a6003c13bae1e2960363b
cd ../moemail-cloudflare-baseline
```

2. Install dependencies:
```bash
pnpm install
```

3. Setup Wrangler:
```bash
cp wrangler.example.json wrangler.json
cp wrangler.email.example.json wrangler.email.json
cp wrangler.cleanup.example.json wrangler.cleanup.json
```
Set Cloudflare D1 database name and database ID.

4. Follow the README in that pinned worktree to configure its historical Pages/D1 runtime. Those settings do not apply to the local Web/API runtime in this branch.

5. Create local database schema:
```bash
pnpm db:migrate-local
```

### Development

1. Start development server:
```bash
pnpm dev
```

2. Test Email Worker:
Currently cannot run and test locally, please use Wrangler to deploy the email worker and test.
```bash
pnpm deploy:email
```

3. Test Cleanup Worker:
```bash
pnpm dev:cleanup
pnpm test:cleanup
```

4. Generate Mock Data (Mailboxes and Messages):
```bash
pnpm generate-test-data
```

### Archived Cloudflare Deployment

#### Video Tutorial
https://www.youtube.com/watch?v=Vcw3nqsq2-E

#### Local Wrangler Deployment

Create a separate pinned worktree, then treat that worktree's README as the sole authority for the archived deployment:

```bash
git worktree add ../moemail-cf-baseline 6c19aefc71ca60bc194a6003c13bae1e2960363b
cd ../moemail-cf-baseline
pnpm install --frozen-lockfile
pnpm dlx tsx ./scripts/deploy/index.ts
```

#### Github Actions Deployment

The workflow retained on the current branch is manual-only and always checks out baseline commit `6c19aefc71ca60bc194a6003c13bae1e2960363b`. It cannot deploy the local-first tree.

#### Deployment Steps

1. Add the following Secrets in GitHub repository settings:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare Account ID
   - `AUTH_GITHUB_ID`: GitHub OAuth App ID
   - `AUTH_GITHUB_SECRET`: GitHub OAuth App Secret
   - `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`: Google OAuth credentials (optional)
   - `AUTH_SECRET`: NextAuth Secret, used to encrypt session, please set a random string
   - `CUSTOM_DOMAIN`: Custom domain for the website (Optional, if empty, uses Cloudflare Pages default domain)
   - `PROJECT_NAME`: Pages project name (Optional, if empty, defaults to moemail)
   - `DATABASE_NAME`: D1 database name (Optional, if empty, defaults to moemail-db)
   - `DATABASE_ID`: Existing D1 database ID (optional)
   - `KV_NAMESPACE_NAME`: Cloudflare KV namespace name, used for site settings (Optional, if empty, defaults to moemail-kv)
   - `KV_NAMESPACE_ID`: Existing KV namespace ID (optional)

2. Open Actions, select `Deploy Cloudflare Baseline (Manual)`, enter `DEPLOY_BASELINE_6c19aef`, and run it.

3. Deployment progress can be viewed in the Actions tab of the repository.

#### Notes
- Ensure all Secrets are set correctly.
- Verify that the run checked out the pinned baseline commit before approving Cloudflare changes.

## Email Domain Configuration

In the MoeMail User Profile page, you can configure the site's email domains. Supports multiple domain configurations, separated by commas.
![Email Domain Configuration](https://pic.otaku.ren/20241227/AQAD88AxG67zeVd-.jpg "Email Domain Configuration")

### Cloudflare Email Routing Configuration

To make email domains effective, you also need to configure email routing in the Cloudflare console to forward received emails to the Email Worker.

1. Login to [Cloudflare Console](https://dash.cloudflare.com/)
2. Select your domain
3. Click "Email" -> "Email Routing" in the left menu
4. If it shows "Email Routing is currently disabled", please click "Enable Email Routing"
![Enable Email Routing](https://pic.otaku.ren/20241223/AQADNcQxG_K0SVd-.jpg "Enable Email Routing")
5. After clicking, it will prompt you to add Email Routing DNS records, click "Add records and enable"
![Add DNS Records](https://pic.otaku.ren/20241223/AQADN8QxG_K0SVd-.jpg "Add DNS Records")
6. Configure Routing Rules:
   - Catch-all address: Enable "Catch-all"
   - Edit Catch-all address
    - Action: Select "Send to Worker"
    - Destination: Select the "email-receiver-worker" you just deployed
    - Save
  ![Configure Routing Rules](https://pic.otaku.ren/20241223/AQADNsQxG_K0SVd-.jpg "Configure Routing Rules")

### Notes
- Ensure domain DNS is hosted on Cloudflare.
- Email Worker must be successfully deployed.
- If Catch-All status is unavailable (stuck loading), please click `Destination addresses` next to `Routing rules`, and bind an email address there.

## Permission System

The project uses a Role-Based Access Control (RBAC) system.

### Role Configuration

New user default roles are configured by the Emperor in the site settings in the User Profile:
- Duke: New users get temporary email, Webhook config permissions, and API Key management permissions.
- Knight: New users get temporary email and Webhook config permissions.
- Civilian: New users have no permissions, need to wait for Emperor to promote to Knight or Duke.

### Role Levels

The system includes four role levels:

1. **Emperor**
   - Website Owner
   - Has all permissions
   - Only one Emperor per site

2. **Duke**
   - Super User
   - Can use temporary email features
   - Can configure Webhook
   - Can create API Key to call OpenAPI
   - Can be demoted to Knight or Civilian by Emperor

3. **Knight**
   - Advanced User
   - Can use temporary email features
   - Can configure Webhook
   - Can be demoted to Civilian or promoted to Duke by Emperor

4. **Civilian**
   - Regular User
   - No permissions
   - Can be promoted to Knight or Duke by Emperor

### Role Upgrade

1. **Become Emperor**
   - The first-run WebUI wizard creates exactly one Emperor account while initializing the selected database.
   - A one-time token stored beside `data/config.yaml` protects the wizard and is removed after successful setup.
   - Database locking prevents concurrent setup attempts from creating multiple Emperors.

2. **Role Changes**
   - The Emperor can set other users as Duke, Knight, or Civilian in the User Profile page.

### Permission Details

- **Email Management**: Create and manage temporary emails
- **Webhook Management**: Configure Webhooks for email notifications
- **API Key Management**: Create and manage API access keys
- **User Management**: Promote/Demote user roles
- **System Settings**: Manage global system settings

## System Settings

System settings are stored in the `site_config` table of the selected SQLite/PostgreSQL database:

- `DEFAULT_ROLE`: Default role for new users, values: `civilian`, `knight`, `duke`
- `EMAIL_DOMAINS`: Supported email domains, comma-separated
- `ADMIN_CONTACT`: Administrator contact info
- `MAX_EMAILS`: Maximum number of emails per user

**Emperor** role can configure these in the User Profile page.

## Sending Emails

MoeMail supports sending emails using temporary addresses, based on [Resend](https://resend.com/) service.

### Features

- 📨 **Send from Temp Email**: Use created temporary emails as sender
- 🎯 **Role Limits**: Different roles have different daily sending limits
- 💌 **HTML Support**: Supports rich text email format

### Role Sending Limits

| Role | Daily Limit | Description |
|------|-------------|-------------|
| Emperor | Unlimited | Admin has no limits |
| Duke | 5/day | Default 5 emails per day |
| Knight | 2/day | Default 2 emails per day |
| Civilian | Forbidden | No sending permission |

> 💡 **Tip**: The Emperor can customize the daily limits for Dukes and Knights in the Mail Service Configuration.

### Configure Sending Service

1. **Get Resend API Key**
   - Register at [Resend](https://resend.com/)
   - Create API Key in console
   - Copy API Key for later use

2. **Configure Service**
   - Login as Emperor
   - Go to User Profile
   - In "Resend Service Configuration":
     - Enable Sending Service switch
     - Enter Resend API Key
     - Set daily limits for Duke and Knight (Optional)
   - Save configuration

3. **Verify Configuration**
   - After saving, authorized users will see a "Send Email" button in the email list
   - Click to open dialog and test

### How to Send

1. **Create Temp Email**
   - Create a new temporary email in Mailbox page

2. **Send Email**
   - Find the email in the list
   - Click "Send Email" button next to it
   - Fill in:
     - Recipient address
     - Subject
     - Content (supports HTML)
   - Click "Send"

3. **View History**
   - Sent emails are saved in the message list of the corresponding mailbox
   - View all sent/received emails in mailbox detail page

### Notes

- 📋 **Resend Limits**: Please note Resend's sending limits and pricing
- 🔐 **Domain Verification**: Using custom domains requires verification in Resend
- 🚫 **Anti-Spam**: Please follow email sending standards, avoid spamming
- 📊 **Quota Monitoring**: System counts daily usage, stops sending when limit reached
- 🔄 **Quota Reset**: Daily quota resets at 00:00

## Webhook Integration

When a new email is received, the system sends a POST request to the configured and enabled Webhook URL.

### Request Header
```http
Content-Type: application/json
X-Webhook-Event: new_message
```

### Request Body
```json
{
  "emailId": "email-uuid",
  "messageId": "message-uuid",
  "fromAddress": "sender@example.com",
  "subject": "Email Subject",
  "content": "Email Text Content",
  "html": "Email HTML Content",
  "receivedAt": "2024-01-01T12:00:00.000Z",
  "toAddress": "your-email@moemail.app"
}
```

### Configuration
1. Click avatar to enter User Profile
2. Enable Webhook
3. Set notification URL
4. Click Test button
5. Save to receive notifications

### Testing

The project provides a simple test server:

```bash
pnpm webhook-test-server
```

The test server listens on port 3001 (http://localhost:3001) and prints received Webhook details.

For external testing, use Cloudflare Tunnel:
```bash
pnpx cloudflared tunnel --url http://localhost:3001
```

### Notes
- Webhook must respond within 10 seconds
- Non-2xx response triggers retry

## OpenAPI

The project provides OpenAPI interfaces, accessible via API Key. API Keys can be created in User Profile (Requires Duke or Emperor role).

### Using API Key

Add API Key to request header:
```http
X-API-Key: YOUR_API_KEY
```

### API Endpoints

#### Get System Config
```http
GET /api/config
```
Response:
```json
{
  "defaultRole": "civilian",
  "emailDomains": "moemail.app,example.com",
  "adminContact": "admin@example.com",
  "maxEmails": "10"
}
```

#### Generate Temp Email
```http
POST /api/emails/generate
Content-Type: application/json

{
  "name": "test",
  "expiryTime": 3600000,
  "domain": "moemail.app"
}
```
Params:
- `name`: Prefix (optional)
- `expiryTime`: Validity in ms. 3600000(1h), 86400000(24h), 604800000(7d), 0(Permanent)
- `domain`: From config

Response:
```json
{
  "id": "email-uuid-123",
  "email": "test@moemail.app"
}
```

#### Get Email List
```http
GET /api/emails?cursor=xxx
```

#### Get Messages for Email
```http
GET /api/emails/{emailId}?cursor=xxx&includeTotal=1
```

`total` is returned only when `includeTotal=1`; polling should omit it to avoid a count query on every request.

#### Delete Email
```http
DELETE /api/emails/{emailId}
```

#### Get Single Message
```http
GET /api/emails/{emailId}/{messageId}
```

#### Create Email Share Link
```http
POST /api/emails/{emailId}/share
Content-Type: application/json

{
  "expiresIn": 86400000
}
```

#### Get Email Share Links
```http
GET /api/emails/{emailId}/share
```

#### Delete Email Share Link
```http
DELETE /api/emails/{emailId}/share/{shareId}
```

#### Create Message Share Link
```http
POST /api/emails/{emailId}/messages/{messageId}/share
Content-Type: application/json

{
  "expiresIn": 86400000
}
```

#### Get Message Share Links
```http
GET /api/emails/{emailId}/messages/{messageId}/share
```

#### Delete Message Share Link
```http
DELETE /api/emails/{emailId}/messages/{messageId}/share/{shareId}
```

## CLI Tool

MoeMail provides an agent-first CLI tool for AI agents and automation workflows.

### Install

```bash
npm i -g @moemail/cli
```

### Quick Start

```bash
# Configure API endpoint and key
moemail config set api-url https://moemail.app
moemail config set api-key YOUR_API_KEY

# Create temporary email
moemail create --domain moemail.app --expiry 1h --json

# List mailboxes
moemail list --json

# List messages in a mailbox
moemail list --email-id EMAIL_ID --json

# Wait for new messages (polling)
moemail wait --email-id EMAIL_ID --timeout 120 --json

# Read message content
moemail read --email-id EMAIL_ID --message-id MESSAGE_ID --json

# Send an email from the temporary address
moemail send --email-id EMAIL_ID --to user@example.com --subject "Hello" --content "Body text" --json

# Delete a single message
moemail delete --email-id EMAIL_ID --message-id MESSAGE_ID

# Delete the whole mailbox
moemail delete --email-id EMAIL_ID
```

### Agent Workflow

A typical AI agent verification flow in 3 tool calls:

```bash
# 1. Create mailbox
EMAIL=$(moemail create --domain moemail.app --expiry 1h --json)
EMAIL_ID=$(echo $EMAIL | jq -r '.id')
ADDRESS=$(echo $EMAIL | jq -r '.address')

# 2. Wait for verification email
MSG=$(moemail wait --email-id $EMAIL_ID --timeout 120 --json)
MSG_ID=$(echo $MSG | jq -r '.messageId')

# 3. Read content, extract verification code
CONTENT=$(moemail read --email-id $EMAIL_ID --message-id $MSG_ID --json)
```

### AI Agent Skill

Install the built-in skill so AI agents (Claude Code, Codex, etc.) automatically know how to use MoeMail:

```bash
# Auto-detect installed agent platforms and install
moemail skill install

# Or specify a platform
moemail skill install --platform claude
moemail skill install --platform codex
```

For full documentation, see [packages/cli/README.md](packages/cli/README.md).

## MCP Server

MoeMail also ships an [MCP](https://modelcontextprotocol.io) server, so any
MCP-capable client (Claude Desktop, Cursor, Cline, …) gets native temporary-email
tools without shelling out to the CLI.

### Tools

| Tool | Description |
|------|-------------|
| `create_email` | Create a temporary mailbox (`1h` / `24h` / `3d` / `permanent`) |
| `list_emails` | List mailboxes owned by the API key |
| `list_messages` | List messages in a mailbox |
| `read_message` | Read full text/HTML of a message |
| `wait_for_email` | Poll for a new message (bounded; returns `status: "timeout"` to retry) |
| `send_email` | Send from a temporary address |
| `delete_email` | Delete a mailbox |
| `delete_message` | Delete a single message |

### Setup

Add the server to your MCP client config (e.g. Claude Desktop `claude_desktop_config.json`).
Credentials are passed via environment variables:

```json
{
  "mcpServers": {
    "moemail": {
      "command": "npx",
      "args": ["-y", "@moemail/mcp"],
      "env": {
        "MOEMAIL_API_KEY": "YOUR_API_KEY",
        "MOEMAIL_API_URL": "https://moemail.app"
      }
    }
  }
}
```

For full documentation, see [packages/mcp/README.md](packages/mcp/README.md).

## Runtime Configuration

The local Web/API has one runtime configuration source: `data/config.yaml`. It does not load application settings from `.env`, Compose `environment`, or systemd `EnvironmentFile` entries.

The first-run WebUI writes the file in a recoverable two-stage setup and generates the session secret, password pepper, and Email Worker ingestion secret. After setup, the Emperor can edit the full YAML in the Runtime Configuration panel; direct file edits are detected about once per second. Changes are parsed and validated before they are committed, database changes are probed and migrated first, and failures leave the previous configuration active. A validated recovery snapshot is kept at `data/config.yaml.lkg`; fingerprint CAS plus a shared save lock rejects stale concurrent WebUI writes.

The schema covers:

- `server`: public base URL, trusted-proxy handling, automatic restart on database-driver changes, and browser polling interval.
- `database`: SQLite path/backup retention or PostgreSQL URL, pool, TLS, and backup settings.
- `auth`: session secret, password pepper, optional OAuth pairs, optional Emperor bootstrap secret, and login/register abuse limits.
- `email.ingestSecret`: the shared secret copied to the Cloudflare Email Worker through Wrangler Secret.
- `cleanup`, `scheduler`, `monitor`, and `offsite`: maintenance intervals, limits, alerts, and rclone destination.

The generated file contains plaintext credentials. Keep the data directory private, back up `config.yaml` and `config.yaml.lkg` together with the database, and never commit them. See [the local deployment guide](docs/local-deployment.zh-CN.md) for a field summary and operational commands.

Cloudflare Email Worker bindings remain on the Worker side: set `EMAIL_INGEST_URL` in Wrangler `vars`, and upload `EMAIL_INGEST_SECRET` with `wrangler secret put`. Wrangler may separately use its own login or CI credentials; the local Web/API never reads them.

## Github OAuth App Configuration

1. Login [Github Developer](https://github.com/settings/developers) create new OAuth App
2. Generate `Client ID` and `Client Secret`
3. Configure:
   - `Application name`: `<your-app-name>`
   - `Homepage URL`: `https://<your-domain>`
   - `Authorization callback URL`: `https://<your-domain>/api/auth/callback/github`
4. Enter the Client ID and Client Secret in the first-run wizard or the Runtime Configuration panel (`auth.github` in `data/config.yaml`)

## Google OAuth App Configuration

1. Visit [Google Cloud Console](https://console.cloud.google.com/) create project
2. Configure OAuth consent screen
3. Create OAuth Client ID
   - Type: Web application
   - Authorized Javascript origins: `https://<your-domain>`
   - Authorized redirect URIs: `https://<your-domain>/api/auth/callback/google`
4. Get `Client ID` and `Client Secret`
5. Enter the Client ID and Client Secret in the first-run wizard or the Runtime Configuration panel (`auth.google` in `data/config.yaml`)

## Contribution

Welcome to submit Pull Requests or Issues to help improve this project.

## License

[MIT](LICENSE)

## Community
<table>
  <tr style="max-width: 360px">
    <td>
      <img src="https://pic.otaku.ren/20250309/AQADAcQxGxQjaVZ-.jpg" />
    </td>
    <td>
      <img src="https://pic.otaku.ren/20250309/AQADCMQxGxQjaVZ-.jpg" />
    </td>
  </tr>
  <tr style="max-width: 360px">
    <td>
      Follow official account for more project updates, AI, Blockchain, and Indie Dev news.
    </td>
    <td>
      Add WeChat, remark "MoeMail" to join the WeChat community group.
    </td>
  </tr>
</table>

## Support

If you like this project, please give it a Star ⭐️
Or sponsor it
<br />
<br />
<img src="https://pic.otaku.ren/20240212/AQADPrgxGwoIWFZ-.jpg" style="width: 400px;"/>
<br />
<br />
<a href="https://www.buymeacoffee.com/beilunyang" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" style="width: 400px;" ></a>

## Star History

<a href="https://www.star-history.com/#beilunyang/moemail&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=beilunyang/moemail&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=beilunyang/moemail&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=beilunyang/moemail&type=Date" />
 </picture>
</a>
