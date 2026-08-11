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

本仓库是 [beilunyang/moemail](https://github.com/beilunyang/moemail) 的本地化分支。Web/API、运行配置、数据库、周期维护和备份都运行在自己的 Linux 主机上。Cloudflare 只作为可选的入站邮件转发层：Email Routing 把邮件交给一个小型 Email Worker，再由 Worker 转发到 MoeMail 的公网 HTTPS 接口。

## 功能

- 单个 Docker Compose 文件部署，不在服务器本地构建镜像，不使用 `.env`。
- GHCR 同时发布 Linux `amd64` 与 `arm64` 镜像，分别由相同架构的 GitHub Runner 原生构建，不使用 QEMU 模拟。
- 支持 SQLite、Compose 内置 PostgreSQL 17，以及外部 PostgreSQL 17/18。
- 浏览器首次初始化，创建唯一的皇帝管理员账号。
- YAML 运行配置支持校验、热加载与最后一次有效配置（LKG）恢复。
- 临时邮箱、有效期与清理、角色权限、OpenAPI Key、Webhook、分享、可选 OAuth 与 Resend 发件。
- 周期清理、数据库备份、监控，以及支持 rclone crypt 的异地备份。
- 提供 CLI 与 MCP 客户端，便于自动化及 AI Agent 使用。

## 生产部署

### 前置条件

- Linux `x86_64` 或 `aarch64` 主机，安装 Docker Engine 与 Docker Compose v2。
- 宿主机安装 Caddy、Nginx 等反向代理，负责公网 HTTPS。
- 三个 GHCR Package 已公开，或宿主机已执行 `docker login ghcr.io`。
- 只有需要通过 Cloudflare Email Routing 接收互联网邮件时，才需要由 Cloudflare 托管邮件域名。

### 1. 下载固定版本的 Compose

生产部署应让 Compose 文件和三个镜像使用同一个发布 tag，不要使用 `latest`：

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

Compose 会拉取以下多架构镜像：

| 用途 | 镜像 |
| --- | --- |
| Web/API 与应用维护任务 | `ghcr.io/xmzo/moemail-local:v0.16.0` |
| 内置 PostgreSQL 17 | `ghcr.io/xmzo/moemail-local-postgres:v0.16.0` |
| PostgreSQL 18 备份/恢复工具 | `ghcr.io/xmzo/moemail-local-postgres-tools:v0.16.0` |

应用只监听 `127.0.0.1:3000`，PostgreSQL 不向宿主机发布端口。

### 2. 完成首次初始化

setup token 会在首次打开初始化页面时生成。先从宿主机访问一次页面，再读取 token：

```bash
curl -fsS http://127.0.0.1:3000/zh-CN/setup >/dev/null
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'
```

通过 SSH 隧道或 HTTPS 反向代理访问站点，在向导中填写公网地址、数据库、首个皇帝账号、运行密钥和可选集成。

数据库选择：

- **SQLite：** 保留默认的 `data/moemail.db`。
- **内置 PostgreSQL：** 使用 `postgresql://moemail@postgres:5432/moemail`。
- **外部 PostgreSQL：** 填写服务商 URL，并在向导中单独配置 TLS。

所有应用设置写入 `data/config.yaml`；应用不会从环境变量读取部署配置。

### 3. 配置宿主机 Caddy

Compose 刻意不内置 Caddy。下面的宿主机配置保留应用请求体限制，并覆盖客户端传入的 IP Header，避免直接信任伪造值：

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

将初始化向导中的公网地址设为同一个 HTTPS Origin，启用可信代理 Header，然后 reload Caddy。保持 3000 端口只监听回环地址，防火墙仅向公网开放宿主机的 80/443。带访问日志轮转的版本化示例位于 [`deploy/local/Caddyfile`](deploy/local/Caddyfile)。

### 4. 配置入站收信

接收邮件仍需要 Cloudflare Email Routing 和 Email Worker，链路如下：

```text
互联网 SMTP -> Cloudflare Email Routing -> Email Worker
            -> https://mail.example.com/api/internal/email -> 本地 MoeMail 数据库
```

Worker 必须使用首次向导生成的同一个 `email.ingestSecret`。直连模式和具备 R2 + Queue 缓冲的耐久模式见[本地部署指南的 Email Worker 章节](docs/local-deployment.zh-CN.md#6-cloudflare-email-worker)。

## 持久化与整目录迁移

删除容器或镜像后仍需保留的内容，都在 `compose.yaml` 同目录：

| 宿主路径 | 内容 |
| --- | --- |
| `./data/` | `config.yaml`、LKG 配置、初始化状态、SQLite 数据库与备份 |
| `./data/postgres/` | 内置 PostgreSQL 物理数据 |
| `./data/postgres-backups/` | PostgreSQL 归档与配对配置快照 |

`docker compose down --rmi all` 只删除容器和镜像，不会删除这些 bind mount 文件。只有显式删除 `./data` 才会丢失本地状态。

需要冷打包整套部署时，先停掉所有写入者，并保留数字 UID/GID：

```bash
set -euo pipefail
docker compose --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-$(date -u +%Y%m%d%H%M%S).tar.gz" compose.yaml data
docker compose --profile '*' start
```

日常运维和灾备演练应使用逻辑备份及独立恢复流程，不要直接复制正在写入的 PostgreSQL 物理目录。详见[备份、恢复与异地同步](docs/local-deployment.zh-CN.md#8-备份恢复与异地同步)。

## 可选 Compose profiles

默认的 `docker compose up -d` 会启动目录初始化、内置 PostgreSQL 和 Web/API。其余服务按需启用：

| Profile | 用途 | 常用命令 |
| --- | --- | --- |
| `maintenance` | 一次性清理与数据库备份 | SQLite：`docker compose --profile maintenance run --rm backup`；PostgreSQL：`docker compose --profile maintenance run --rm postgres-backup` |
| `scheduler` | 常驻清理与备份调度 | `docker compose --profile scheduler up -d scheduler postgres-backup-scheduler` |
| `monitoring` | 运行状态与磁盘监控 | `docker compose --profile monitoring up -d monitor` |
| `offsite` | 周期执行 rclone 异地复制 | `docker compose --profile offsite up -d offsite-backup` |
| `restore` | 显式 PostgreSQL 恢复工具 | 执行前严格按照恢复手册操作 |

不要同时运行 Compose scheduler 和宿主机的 systemd scheduler。启用对应 profile 前，先在 WebUI 运行配置中设置监控阈值、备份保留周期和异地凭据。

## 升级与安全检查

1. 先生成有效的数据库 + `config.yaml.lkg` 配对备份，并复制到部署目录之外。
2. 下载新 release 的 `compose.yaml`，将三个镜像统一固定为同一个不可变版本 tag（或 digest）。
3. 执行 `docker compose config --quiet`、`docker compose pull` 和 `docker compose up -d`。
4. 检查 `docker compose ps`、健康状态、登录、收信和备份输出，全部通过后再判定升级完成。
5. 定期在独立目录恢复演练；只修改 Compose project name 不能隔离相对路径 bind mount。

生产环境必须守住以下边界：

- 不要发布内置 PostgreSQL 端口；它的 trust 认证只用于隔离的 Compose 内部网络。
- `data/config.yaml`、`data/config.yaml.lkg`、数据库和备份都含敏感信息，禁止提交 `data/`。
- 应用只通过宿主 HTTPS 反代开放，使用强管理员密码，并且只启用确实需要的 OAuth、Webhook、Resend 或异地同步功能。
- 使用固定版本 tag 或 digest，不要在生产中使用 `latest`；每次升级前先制作可恢复备份。
- 对公网提供服务前，完整阅读[部署与运维指南](docs/local-deployment.zh-CN.md)。

## 开发与验证

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

开发服务器使用 `pnpm dev`。本地运行也必须完成首次初始化，之后应用路由才可正常使用。

相关文档：

- [本地部署、Email Worker、备份恢复、迁移与 systemd 完整指南](docs/local-deployment.zh-CN.md)
- [验证记录与仍需在部署环境执行的验收项](docs/local-validation.zh-CN.md)
- [CLI 包](packages/cli/README.md)
- [MCP 包](packages/mcp/README.md)

## 上游与许可证

MoeMail Local 基于 [beilunyang/moemail](https://github.com/beilunyang/moemail)，本地化改造维护于 [XMZO/moemail-local](https://github.com/XMZO/moemail-local)。由于运行时和部署模型不同，合并上游功能或安全修复时应先审查和验证，不能直接假定兼容。

本项目采用 [MIT License](LICENSE)。
