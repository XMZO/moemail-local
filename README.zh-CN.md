<p align="center">
  <img src="public/icons/icon-192x192.png" alt="MoeMail Logo" width="100" height="100">
  <h1 align="center">MoeMail Local</h1>
</p>

<p align="center">
  基于 Next.js 与 SQLite/PostgreSQL 的 local-first 自托管临时邮箱服务。
</p>

<p align="center">
  <a href="./README.md">English</a> |
  <span>简体中文</span>
</p>

本仓库是 [beilunyang/moemail](https://github.com/beilunyang/moemail) 的本地化分支。Web/API、运行配置、数据库、周期维护和备份都运行在自己的 Linux 主机上。Cloudflare 只作为可选的入站邮件转发层：Email Routing 把邮件交给 Email Worker，再由 Worker 转发到 MoeMail 的公网 HTTPS 接口。

## 功能

- 两个独立 Docker Compose 方案：轻量 SQLite 部署和内置 PostgreSQL 部署。
- GHCR 同时发布 Linux `amd64` 与 `arm64` 镜像，由相同架构的 GitHub Runner 原生构建，不使用 QEMU 模拟。
- 浏览器首次初始化，创建唯一的皇帝管理员账号。
- YAML 运行配置支持校验、热加载与最后一次有效配置（LKG）恢复。
- 临时邮箱、有效期与清理、角色权限、OpenAPI Key、Webhook、分享、可选 OAuth 与 Resend 发件。
- 周期清理、数据库备份、监控与 rclone 异地备份。
- 提供 CLI 与 MCP 客户端，便于自动化及 AI Agent 使用。

## 只能选择一个 Compose 文件

| 部署方式 | 文件 | 启动命令 | 拉取的镜像 |
| --- | --- | --- | --- |
| SQLite | `compose.yml` | `docker compose up -d` | `ghcr.io/xmzo/moemail-local:latest` |
| 内置 PostgreSQL 18 | `compose.postgres.yml` | `docker compose -f compose.postgres.yml up -d` | `latest` 的应用、PostgreSQL 与 PostgreSQL 工具镜像 |

两个文件都是完整、独立的部署定义。**禁止使用多个 `-f` 参数叠加它们**，也不要让两套部署同时使用同一个 `./data`。它们使用相同的项目名、回环端口和持久化路径。切换数据库需要按迁移流程执行，不能靠 Compose 覆盖完成。

两个方案都不使用 `.env`、Compose 应用环境变量、服务器本地镜像构建或内置 Caddy 容器；Web 都只绑定 `127.0.0.1:3000`，全部状态都位于 `./data`。

如果从旧的 `v0.16.1` 单文件部署升级，必须先用原文件名停止它，并把旧文件移走，再下载且只下载一个新方案：

```bash
docker compose -f compose.yaml --profile '*' down
mv compose.yaml compose.v0.16.1.yaml
```

不要添加 `-v`，必须保留 bind mount 的 `./data`。也不要让 `compose.yaml` 留在原处，否则普通 `docker compose` 仍可能优先选中旧文件，而不是新的 `compose.yml`。

## 生产部署

### 前置条件

- Linux `x86_64` 或 `aarch64` 主机，安装 Docker Engine 与 Docker Compose v2。
- 宿主机安装 Caddy、Nginx 等反向代理，负责公网 HTTPS。
- 所需 GHCR Package 已公开，或宿主机已执行 `docker login ghcr.io`。
- 只有需要通过 Cloudflare Email Routing 接收互联网邮件时，才需要由 Cloudflare 托管邮件域名。

### 方案 A：SQLite

SQLite 是最精简的部署，只拉取应用镜像：

```bash
set -euo pipefail
mkdir -p moemail
cd moemail
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/master/compose.yml \
  -o compose.yml
docker compose config --quiet
docker compose up -d
docker compose ps
```

首次向导保留默认数据库路径 `data/moemail.db`。

### 方案 B：内置 PostgreSQL

PostgreSQL 部署会拉取三个镜像：

- `ghcr.io/xmzo/moemail-local:latest`
- `ghcr.io/xmzo/moemail-local-postgres:latest`
- `ghcr.io/xmzo/moemail-local-postgres-tools:latest`

```bash
set -euo pipefail
mkdir -p moemail
cd moemail
curl -fsSL \
  https://raw.githubusercontent.com/XMZO/moemail-local/master/compose.postgres.yml \
  -o compose.postgres.yml
docker compose -f compose.postgres.yml config --quiet
docker compose -f compose.postgres.yml up -d
docker compose -f compose.postgres.yml ps
```

首次向导选择 PostgreSQL，并使用：

```text
postgresql://moemail@postgres:5432/moemail
```

内置数据库只在隔离的 Compose 网络中使用 trust 认证，不向宿主机发布 5432。

### 完成首次初始化

先通过 SSH 隧道或 HTTPS 反向代理访问站点。加载 setup 页面后才会生成一次性 token，然后执行与所选方案对应的命令：

```bash
# SQLite
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'

# PostgreSQL
docker compose -f compose.postgres.yml \
  exec -T moemail sh -c 'cat /app/data/setup-token'
```

在向导中填写公网地址、数据库、首个皇帝账号、运行密钥和可选集成。所有应用设置写入 `data/config.yaml`；应用不会从环境变量读取部署配置。

## 宿主机 Caddy

两个 Compose 文件都不内置 Caddy。下面的宿主机配置保留应用请求体限制，并覆盖客户端传入的 IP Header，避免直接信任伪造值：

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

将首次向导中的公网地址设为同一个 HTTPS Origin，启用可信代理 Header，然后 reload Caddy。保持 3000 端口只监听回环地址，防火墙仅向公网开放宿主机的 80/443。带访问日志轮转的版本化示例位于 [`deploy/local/Caddyfile`](deploy/local/Caddyfile)。

## 入站收信

接收邮件仍需要 Cloudflare Email Routing 和 Email Worker：

```text
互联网 SMTP -> Cloudflare Email Routing -> Email Worker
            -> https://mail.example.com/api/internal/email -> 本地 MoeMail 数据库
```

Worker 必须使用首次向导生成的同一个 `email.ingestSecret`。建议先部署直连模式；可以在安装了 Git、Node.js 22 和 Corepack 的电脑上完成，不必在 MoeMail 服务器上执行。只下载 Compose 的部署目录不含 Worker 源码，以下命令会取得完整的对应版本源码：

```bash
git clone --branch v0.16.4 --depth 1 https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm exec wrangler login
cp wrangler.email.example.json wrangler.email.json
```

仅将 `wrangler.email.json` 中已有的 `EMAIL_INGEST_URL` 改成 MoeMail 的公网 HTTPS 地址；下面是配置片段，不要用它覆盖整个文件：

```json
{
  "vars": {
    "EMAIL_INGEST_URL": "https://mail.example.com/api/internal/email"
  }
}
```

在首次向导成功页或皇帝账号的“运行配置”中复制 `email.ingestSecret`。Secret 只在下面的 Wrangler 提示中粘贴，不要写入 JSON 或提交 Git：

```bash
pnpm exec wrangler secret put EMAIL_INGEST_SECRET --config wrangler.email.json
pnpm deploy:email
```

首次执行 `secret put` 时，如果 Wrangler 询问是否创建 `email-receiver-worker`，确认创建即可。部署完成后，先在 Cloudflare 控制台为域名启用 Email Routing 并按提示配置 MX，再进入 **Email Routing → Routing rules**，将 catch-all 或指定收件地址设置为 **Send to a Worker**，并选择 `email-receiver-worker`。发送一封测试邮件，同时查看实时日志：

```bash
pnpm exec wrangler tail --config wrangler.email.json
```

直连模式要求 `EMAIL_INGEST_URL` 是完整的公网 HTTPS `/api/internal/email` 地址，不能使用 `localhost` 或 Compose service 名；本地离线时不保证耐久重试。需要 R2 + Queue 缓冲时，改用[本地部署指南中的耐久模式](docs/local-deployment.zh-CN.md#62-r2--queue-耐久模式)。

## 持久化与整目录迁移

两个方案都把状态放在所选 Compose 文件旁边：

| 宿主路径 | 内容 |
| --- | --- |
| `./data/` | `config.yaml`、LKG 配置、初始化状态、SQLite 数据库与 SQLite 备份 |
| `./data/postgres/` | 内置 PostgreSQL 物理数据，仅 PostgreSQL 方案使用 |
| `./data/postgres-backups/` | PostgreSQL 归档与配对配置快照，仅 PostgreSQL 方案使用 |

删除容器或镜像不会删除这些 bind mount 文件；只有显式删除 `./data` 才会丢失本地状态。

需要冷打包时，将 `compose_file` 设置为实际部署的唯一文件：

```bash
set -euo pipefail
compose_file=compose.yml
# PostgreSQL 部署改为：compose_file=compose.postgres.yml
docker compose -f "$compose_file" --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-$(date -u +%Y%m%d%H%M%S).tar.gz" "$compose_file" data
docker compose -f "$compose_file" --profile '*' start
```

日常灾备演练使用逻辑备份和独立恢复流程，不要直接复制正在写入的 PostgreSQL 物理目录。详见[备份、恢复与异地同步](docs/local-deployment.zh-CN.md#8-备份恢复与异地同步)。

## 可选 profiles

SQLite 使用默认文件：

```bash
docker compose --profile maintenance run --rm --no-deps cleanup
docker compose --profile maintenance run --rm --no-deps backup
docker compose --profile scheduler up -d scheduler
docker compose --profile monitoring up -d monitor
docker compose --profile offsite up -d offsite-backup
```

PostgreSQL 的每条命令都必须指定其独立文件：

```bash
docker compose -f compose.postgres.yml --profile maintenance \
  run --rm postgres-backup
docker compose -f compose.postgres.yml --profile scheduler \
  up -d scheduler postgres-backup-scheduler
docker compose -f compose.postgres.yml --profile monitoring up -d monitor
docker compose -f compose.postgres.yml --profile offsite up -d offsite-backup
```

不要同时运行 Compose scheduler 和宿主机 systemd scheduler。启用 profile 前，先在 WebUI 中设置监控阈值、保留周期和异地凭据。PostgreSQL 恢复刻意要求显式操作，请严格按照恢复手册执行。

## 升级与安全检查

1. 记录部署使用的是 `compose.yml` 还是 `compose.postgres.yml`；普通镜像升级期间禁止切换方案。
2. 使用当前版本生成有效的数据库 + `config.yaml.lkg` 配对备份，并导出到 `./data` 之外。
3. Compose 结构有更新时，从 `master` 下载同名文件为临时文件，并执行 `docker compose -f <临时文件> config --quiet`；仅更新镜像时可保留现有文件。
4. 只替换所选文件，然后使用该文件依次执行 `pull`、`up -d`、`ps`、数据库校验、登录、收信和备份检查。
5. 定期在独立目录恢复演练；只修改 Compose project name 不能隔离相对路径 bind mount。

生产环境必须守住以下边界：

- 禁止叠加两个 Compose 文件，也不要发布内置 PostgreSQL 端口。
- `data/config.yaml`、`data/config.yaml.lkg`、数据库和备份都含敏感信息，禁止提交 `data/`。
- 应用只通过宿主 HTTPS 反代开放，并且只启用确实需要的集成。
- Compose 有意跟踪 `latest`；只在整个镜像发布 Action 成功后执行 `pull`，每次更新前先制作可恢复备份。需要回滚时，将同一方案的全部镜像一起固定到同一个旧 tag 或 digest。
- 对公网提供服务前，完整阅读[部署与运维指南](docs/local-deployment.zh-CN.md)。

## 开发与验证

```bash
git clone --branch v0.16.4 --depth 1 https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit --incremental false
pnpm validate:no-local-env
pnpm validate:deployment
pnpm validate:email-worker
```

开发服务器使用 `pnpm dev`。本地运行也必须完成首次初始化，之后应用路由才可正常使用。

相关文档：

- [本地部署、Email Worker、备份恢复、迁移与 systemd 完整指南](docs/local-deployment.zh-CN.md)
- [验证记录与仍需在部署环境执行的验收项](docs/local-validation.zh-CN.md)
- [CLI 包](packages/cli/README.md)
- [MCP 包](packages/mcp/README.md)

## 上游与许可证

MoeMail Local 基于 [beilunyang/moemail](https://github.com/beilunyang/moemail)，本地化改造维护于 [XMZO/moemail-local](https://github.com/XMZO/moemail-local)。由于运行时和部署模型不同，合并上游功能或安全修复时应先审查和验证。

本项目采用 [MIT License](LICENSE)。
