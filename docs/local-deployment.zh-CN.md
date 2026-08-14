# MoeMail 主要本地部署

本地模式在服务器运行 Next.js Node、SQLite 或 PostgreSQL 与定时维护任务。收件可选择 Cloudflare Email Worker，或由 Web 进程从外部邮局 IMAP 只读拉取。应用不使用 `.env`、Compose `environment` 或 systemd `EnvironmentFile`；唯一进程运行配置是工作目录下的 `data/config.yaml`。

选择 Cloudflare Email Routing 时，Email Worker 仍使用 Wrangler `vars`/Secret，因为它们属于 Worker 的远端 binding，不是本地应用配置。选择外部 IMAP 时无需 Cloudflare，但邮局必须提供 catch-all/全域转发，并保留可识别原始收件地址的 Header。

仓库提供两个互斥的 standalone 部署目录：`sqlite/docker-compose.yml` 默认只运行轻量 Web；`postgres/docker-compose.yml` 默认运行轻量 Web 与内置 PostgreSQL 18。备份、恢复、迁移、校验、监控和异地同步使用按需拉取的 `ghcr.io/xmzo/moemail-local:latest-tools`，PostgreSQL 归档另用 `ghcr.io/xmzo/moemail-local-postgres-tools:latest`。只进入其中一个目录，日常命令都是普通 `docker compose ...`；各目录相邻的 `./data` 天然隔离，复制或打包整个目录即可同时带走部署定义与数据。不能用多个 `-f` 参数叠加两者。镜像只在 Docker-compatible Git tag（例如 `v0.19.7`，不含 `/`）push 或手动触发 `Publish Docker Images` 时发布。amd64 使用 `ubuntu-24.04`，arm64 使用 `ubuntu-24.04-arm` 原生 runner 构建，不使用 QEMU 模拟；Web、应用维护、PostgreSQL server 和 PostgreSQL tools 四种变体都先在对应架构 runner 上执行 smoke test，两个 native digest 最后合并成同一 multi-arch tag。带 `/` 的 Git tag不自动触发，可改用手动输入 `publish_tag`。

首次成功发布后，到 GitHub Packages 中确认实际使用的 container package visibility 为 **Public**，否则未登录的 Compose 主机无法拉取；PostgreSQL 方案需要确认全部三个 package。稳定 semver tag 会同时刷新 `latest` 与应用维护用的 `latest-tools`。必须等待整个发布 Action 的四个 manifest 全部成功后再执行 `pull`；回滚时把所选方案的 Web、维护、数据库和数据库工具标签一起固定到同一旧版本或 digest。不能借升级切换数据库方案，也不通过 `.env` 选 tag。两个 Compose 都不内置 Caddy，只把 Web 绑定到宿主 `127.0.0.1:3000`，HTTPS/TLS 由宿主机上的 Caddy 或其他反向代理负责。

从 `v0.16.1` 的旧 `compose.yaml` 升级时，先用 `docker compose -f compose.yaml --profile '*' down` 停止旧服务，再执行 `mv compose.yaml compose.v0.16.1.yaml`。禁止添加 `-v`，必须保留 `./data`；随后只下载下文与你所选数据库一致的一个 `.yml` 文件。旧 `compose.yaml` 不得留在原路径，否则无 `-f` 的命令可能继续选择旧部署定义。

## 1. 服务器与数据库选择

- 推荐 Node.js 22 LTS、pnpm 11.21.0、Caddy 2；裸机构建原生依赖还需要 `build-essential` 与 `python3`。启用异地同步需安装 `rclone`；裸机 PostgreSQL 备份/恢复需安装与服务端同主版本的 `pg_dump`/`pg_restore`。`sqlite3` 只在把 D1 SQL 转成导入源库时需要；Wrangler 只用于 Email Worker 或 D1 导出。
- 数据库应放在本机 SSD/NVMe 持久化目录，不要把 SQLite 放在 NFS、SMB 或容器临时层。
- 最小 1 vCPU / 1 GiB；生产建议从 2 vCPU / 2 GiB 起步。

| 配置 | 建议同时在线 | 邮箱/邮件规模 | 使用特征 |
| --- | ---: | ---: | --- |
| 1 vCPU / 1 GiB | 20–50 | 1 万邮箱、10 万封邮件 | 低频个人/小团队，每分钟少量收信 |
| 2 vCPU / 2–4 GiB | 50–150 | 5 万邮箱、30 万封邮件 | 中低频公开站，每分钟数十封收信 |
| 4 vCPU / 4–8 GiB | 150–500 | 10 万邮箱、100 万封邮件 | 较活跃单机站，需要监控慢查询与带宽 |

SQLite 只允许一个 Next.js 写实例。需要多实例、持续高写入、在线人数长期超过数百或数据库高可用时，选择 PostgreSQL。`postgres/docker-compose.yml` 内置的是单节点 PostgreSQL；高可用要使用外部托管/集群数据库并另外完成故障切换演练，不能把两个 Compose 文件叠加成高可用方案。

## 2. 首次启动：全部在 WebUI 初始化

### 2.1 裸机或源码运行

```bash
git clone https://github.com/XMZO/moemail-local.git
cd moemail-local
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm start --hostname 127.0.0.1 --port 3000
```

若首次向导选择 PostgreSQL，driver 提交成功后当前 production 进程会正常退出；Docker/systemd 会自动拉起，直接运行时请再次执行上面的 `pnpm start`。这不是初始化失败。

未初始化时，启动过程不会迁移默认数据库，健康接口返回 `status=setup-required`。先访问站点；初始化页面出现后，从 `data/setup-token` 或启动日志中的 `setup.token.ready` 取得一次性令牌，再在向导填写：

- 站点公网 URL、是否信任经过清洗的代理头、浏览器轮询间隔。
- 数据库类型：SQLite 文件路径，或 PostgreSQL URL 与 TLS 选项。
- 唯一皇帝账号的用户名和密码。
- 可选的 GitHub/Google OAuth Client ID 与 Client Secret。
- “高级 YAML”中的连接池、备份、cleanup、scheduler、monitor、认证限流、告警与 rclone 异地同步。高级 YAML 先合并，上方结构化字段同名时优先；`setup`/`version` 由服务端控制，生成的 secret 不会在匿名页面回显。每域 IMAP/SMTP 凭据在登录后的“域名收发”中配置，不写在匿名向导 YAML 中。

“测试连接”只探测候选数据库，不写配置。最终提交会先再次探测、迁移并检查目标库站主；通过后执行可恢复的两阶段提交：原子保存 `setup.completed=false` 与固定的随机 secret/pepper，创建唯一皇帝，再原子切换为 `setup.completed=true`（保存阶段也会重验候选数据库）。若进程在中间退出，使用同一用户名和密码重试会复用已落盘的 pepper；目标库已有不同站主时返回 409，不会把现有账号锁死。跨进程 setup lock 保证同一数据卷只有一个初始化操作。成功后 `data/setup-token` 自动删除；页面只在这时显示 Worker 模式需要的投递 secret。

恢复页面在验证一次性令牌前不会回显已暂存的 PostgreSQL URL、OAuth secret、告警令牌或 rclone 配置；留空的隐藏字段由服务端保留，需要变更时可重新明确填写。

一次性令牌能创建站主，切勿发到聊天、工单或公开日志系统。初始化前应让 3000 端口只对管理员网络开放；令牌文件和生成的配置文件都应保持 `0600`，`data/` 目录应为 `0700`。

### 2.2 初始化后的两种修改方式

- 皇帝登录后进入“个人中心 → 运行配置”，使用完整视觉表单或原始 YAML 编辑并保存；两种草稿切换会双向同步。
- 运维人员直接编辑工作目录下的 `data/config.yaml`。

文件监视器约每秒检测一次修改。候选内容依次经过 YAML 解析、schema 校验、数据库连通性和 migration 校验；全部成功才切换。YAML 写坏、字段越界、PostgreSQL 不可达或 migration 失败时，磁盘上的候选文件仍可供排错，但运行进程继续使用上一份可用配置，并在配置状态/日志中报告问题。

每次成功应用都会更新 `data/config.yaml.lkg`。冷启动遇到损坏或尚未验证的新候选文件时，会优先恢复该 last-known-good 副本。WebUI 保存使用原始文件 SHA-256 fingerprint 与共享保存锁做跨进程 CAS；两个管理员或多个 Web 进程同时保存时，旧版本收到 409，不会覆盖新版本。revision 只用于进程内状态展示。

同一数据库类型下修改 SQLite 路径、PostgreSQL URL/连接池或 TLS 参数，会先建立并验证新连接，再替换旧连接。只有 `database.driver` 在 `sqlite` 与 `postgres` 间切换需要 Web 进程重启；production 默认自动退出，由 Docker `restart: unless-stopped` 或 systemd `Restart=always` 拉起。其他 Web 配置热加载；按域 IMAP/SMTP/Resend 策略与用户权限直接热生效。

### 2.3 配置 schema

所有相对路径都相对于进程工作目录；容器工作目录是 `/app`。以下是当前 schema 的主要字段和默认值：

| 路径 | 默认值/约束 | 说明 |
| --- | --- | --- |
| `version` | `1` | 配置格式版本 |
| `setup.completed` | 首次成功后为 `true` | 初始化状态，不要随意改回 `false` |
| `setup.completedAt` | `null` | 由服务端写入的初始化完成时间 |
| `server.baseUrl` | `http://localhost:3000` | 生成 metadata 与绝对链接时使用的公网根地址；OAuth 回调按实际请求 Host 推导 |
| `server.trustProxyHeaders` | `false` | 仅在可信代理覆盖客户端 IP 头时开启 |
| `server.autoRestartOnDriverChange` | `true` | 切换数据库类型后自动退出重启 |
| `server.emailPollIntervalMs` | `25000`，范围 5000–600000 | 浏览器收件箱轮询间隔 |
| `database.driver` | `sqlite` | `sqlite` 或 `postgres` |
| `database.sqlite.path` | `data/moemail.db` | SQLite 文件；禁止 `:memory:`，也不能占用配置、setup token 或配置锁路径 |
| `database.sqlite.backupDir` | `data/backups` | SQLite 备份目录；不能等于数据库文件或位于该文件路径之下 |
| `database.sqlite.backupRetentionDays` | `30` | 备份保留天数 |
| `database.postgres.url` | `null` | 必须显式含 host/user/database；禁止全部 URL query 参数，TLS、超时和 application name 使用对应 YAML 字段 |
| `database.postgres.poolMax` | `10` | 每进程连接池上限 |
| `database.postgres.idleTimeoutMs` | `30000` | 空闲连接超时 |
| `database.postgres.connectTimeoutMs` | `10000` | 建连超时 |
| `database.postgres.ssl` | `false` | 是否使用 TLS |
| `database.postgres.sslRejectUnauthorized` | `true` | TLS 时是否严格校验证书；Web 与备份/恢复工具使用同一策略 |
| `database.postgres.applicationName` | `moemail` | PostgreSQL application name |
| `database.postgres.backupDir` | `data/postgres-backups` | 必须位于该目录或其子目录；Compose 与 offsite 共享同一 bind 目录 |
| `database.postgres.backupRetentionDays` | `14` | 备份保留天数 |
| `auth.secret` | 向导生成，至少 32 字节 | 会话 secret |
| `auth.passwordPepper` | 向导生成，至少 32 字节 | 已初始化后禁止直接轮换，否则现有账号无法登录 |
| `auth.emperorBootstrapSecret` | `null` | 可选的兼容管理接口 secret；通常保持关闭 |
| `auth.github` / `auth.google` | 两项均为 `null` | `clientId` 与 `clientSecret` 必须成对填写 |
| `auth.rateLimit.*` | 300 秒；登录 20/300，注册 5/60 | 单客户端/全局限制、最多 10000 个客户端桶、最多 2 个并发 scrypt |
| `email.ingestSecret` | 向导生成，至少 32 字节 | Worker 调用 `/api/internal/email` 的鉴权 secret |
| `cleanup.*` | batch 500、总行数 50000、锁过期 360 分钟 | 过期邮箱/消息清理限制 |
| `scheduler.*` | cleanup 3600 秒、backup 86400 秒、启动时备份 | Compose 与 systemd 常驻 scheduler 的动态间隔 |
| `monitor.*` | 检查 300 秒、磁盘 10%/2 GiB | health、磁盘、WAL/PG 大小、5xx、投递失败与告警 |
| `offsite.*` | remote/config `null`、间隔 3600 秒、命令 `rclone` | 异地目标、`rcloneConfigContent`、执行路径与动态间隔 |

四个 runtime secret 必须互不相同、至少 32 字节、无空白且不能是示例占位符。OAuth 的 ID/Secret 也不能只填一半。生成的 YAML 含明文凭据，不要提交；数据库备份之外还要单独安全备份 `config.yaml` 与 `config.yaml.lkg`。

为保证 Compose 中 Web、维护与异地同步容器看到同一 bind 目录，`database.sqlite.path` 必须是 `data/` 内的相对文件，`database.sqlite.backupDir` 必须位于 `data/`；裸机若要使用其他磁盘，请把它挂载或软链接到该目录。PostgreSQL 部署目录的备份固定在 `data/postgres-backups` 子树。

业务设置保存在所选数据库的 `site_config` 表中。WebUI 可按域分别选择 Worker/IMAP/关闭收件与 Resend/SMTP/关闭发件；每个域保存自己的凭据，IMAP 游标也随数据库备份。还可按角色及单用户设置查看、收发、创建、删除、分享、管理权限和数量/大小/有效期额度，并设置默认角色、Turnstile、Webhook 与全站字体。皇帝权限由代码固定为全开且不限额，角色表和用户覆盖 API 都不能修改。运行配置和业务配置都能通过 WebUI 管理，但二者的持久化位置不同。

## 3. Docker Compose：SQLite standalone

`sqlite/docker-compose.yml` 是 SQLite 的完整部署文件。它没有 `environment`、`env_file`、`${...}` 插值或本地 `build`，也不含 PostgreSQL 服务、网络或镜像引用。先建立独立目录并进入，默认命令只启动目录初始化和 Web：

```bash
set -euo pipefail
mkdir -p moemail-sqlite
cd moemail-sqlite
compose_ref=master
curl -fsSL \
  "https://raw.githubusercontent.com/XMZO/moemail-local/$compose_ref/sqlite/docker-compose.yml" \
  -o docker-compose.yml
docker compose config --quiet
docker compose up -d
docker compose ps
```

全部状态都在同目录 `./data`：`config.yaml`、`config.yaml.lkg`、setup token、SQLite 库与 SQLite 备份。首次 `storage-init` 会在标准 Linux rootful Docker 中把 bind 目录准备给容器 UID 10001；rootless Docker、NAS 或不允许容器内 `chown` 的文件系统需先验证权限。应用 package 必须已公开或宿主已登录 GHCR。

先通过 SSH tunnel 或宿主 HTTPS 代理访问站点；setup 页面出现后才会创建 token，再读取：

```bash
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'
```

向导选择 SQLite，保留默认 `data/moemail.db`。Web 只映射 `127.0.0.1:3000:3000`；不要为了公网访问把它改成 `0.0.0.0`，应让宿主 Caddy/Nginx 反代。`docker compose down --rmi all` 不会删除 `./data`。

冷打包时停止所有已创建的 profile 服务，并把唯一实际使用的 Compose 文件和数据一起归档：

```bash
set -euo pipefail
docker compose --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-sqlite-$(date -u +%Y%m%d%H%M%S).tar.gz" docker-compose.yml data
docker compose --profile '*' start
```

一次性维护与常驻服务：

```bash
docker compose --profile maintenance run --rm --no-deps cleanup
docker compose --profile maintenance run --rm --no-deps backup
docker compose --profile scheduler up -d scheduler
docker compose --profile monitoring up -d monitor
docker compose --profile offsite up -d offsite-backup
```

不要同时启用 Compose scheduler 与宿主 `moemail-scheduler.service`。在运行配置中填写 monitor 阈值、告警和 `offsite.remote`；Compose 应把完整 rclone INI 写入 `offsite.rcloneConfigContent`。YAML 与 LKG 含明文凭据，必须按 secret 文件保护。

升级前必须用当前镜像生成并导出 SQLite + 配置 pair，再下载目标 release 的 `sqlite/docker-compose.yml`：

```bash
set -euo pipefail
archive_dir=/srv/moemail-offsite
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$archive_dir"
umask 077
backup_dir="$(docker compose --profile maintenance run --rm --no-deps -T \
  --entrypoint node backup /app/deploy/docker/config-reader.cjs \
  get database.sqlite.backupDir data/backups)"
backup_name="moemail-upgrade-$(date -u +%Y-%m-%dT%H-%M-%S-%N)-$$.db"
backup_path="/app/$backup_dir/$backup_name"
docker compose --profile maintenance run --rm --no-deps backup backup "$backup_path"
docker compose --profile maintenance run --rm --no-deps -T \
  --entrypoint cat backup "$backup_path" > "$archive_dir/$backup_name"
docker compose --profile maintenance run --rm --no-deps -T \
  --entrypoint cat backup "$backup_path.config.yaml.lkg" \
  > "$archive_dir/$backup_name.config.yaml.lkg"
test -s "$archive_dir/$backup_name"
test -s "$archive_dir/$backup_name.config.yaml.lkg"
compose_ref=master
curl -fsSL \
  "https://raw.githubusercontent.com/XMZO/moemail-local/$compose_ref/sqlite/docker-compose.yml" \
  -o docker-compose.yml.next
docker compose -f docker-compose.yml.next config --quiet
mv -T docker-compose.yml.next docker-compose.yml
docker compose pull
docker compose up -d
docker compose ps
```

SQLite 恢复会保留旧库的时间戳 safety 副本。先生成当前安全备份，停止所有访问者，然后通过专用 `restore` service 恢复；service 名之后直接给备份路径，不要再重复 `restore` 子命令：

```bash
set -euo pipefail
docker compose --profile maintenance run --rm --no-deps backup
docker compose --profile '*' stop
docker compose --profile restore run --rm restore \
  /app/data/backups/moemail-2026-08-11T03-23-00.000Z.db --force
docker compose --profile maintenance run --rm --no-deps verify
docker compose up -d moemail
```

verify 成功后再开放 Web，并只重新启动此前启用的 profiles。

## 4. Docker Compose：内置 PostgreSQL standalone

`postgres/docker-compose.yml` 是另一套完整部署，不能与 SQLite 方案叠加。进入 PostgreSQL 部署目录后无需写 `-f`。它从同一次成功发布的 `latest` 拉取应用、内置 PostgreSQL 18 服务和同版本备份/恢复工具镜像；内置数据库不发布 5432，只连接 Compose 的 `internal: true` 网络并在隔离网内使用 trust 认证。

```bash
set -euo pipefail
mkdir -p moemail-postgres
cd moemail-postgres
compose_ref=master
curl -fsSL \
  "https://raw.githubusercontent.com/XMZO/moemail-local/$compose_ref/postgres/docker-compose.yml" \
  -o docker-compose.yml
docker compose config --quiet
docker compose up -d
docker compose ps
```

已有 PostgreSQL 目录可按 README 的迁移命令一次性改名：它兼容旧文件名 `compose.postgres.yml` 或 `compose.yml`，会先用 `config --services` 确认其中确实存在 `postgres` 服务，再保留冲突默认文件并改成 `docker-compose.yml`。Compose project name 和 `./data` 不变。

先访问 WebUI 生成 token，再读取并在向导选择 PostgreSQL：

```bash
docker compose exec -T moemail sh -c 'cat /app/data/setup-token'
```

内置数据库 URL：

```text
postgresql://moemail@postgres:5432/moemail
```

配置位于 `./data`，主数据库位于 `./data/postgres`，归档与配置 pair 位于 `./data/postgres-backups`。不要删除其中任一目录，除非确定要永久删除配置、主库和备份。冷打包前必须停止 PostgreSQL，不能在线复制物理目录：

```bash
set -euo pipefail
docker compose --profile '*' stop
sudo tar --numeric-owner -czf \
  "../moemail-postgres-$(date -u +%Y%m%d%H%M%S).tar.gz" \
  docker-compose.yml data
docker compose --profile '*' start
```

维护、调度、监控和异地同步也直接使用默认文件：

```bash
docker compose --profile maintenance run --rm postgres-backup
docker compose --profile scheduler up -d scheduler postgres-backup-scheduler
docker compose --profile monitoring up -d monitor
docker compose --profile offsite up -d offsite-backup
```

PostgreSQL backup sidecar 使用 PostgreSQL 18 `pg_dump` 生成 custom format，以非 root 用户运行，并在原子改名前执行快照内验证和 `pg_restore --list`。列出并导出备份：

```bash
set -euo pipefail
archive_dir=/srv/moemail-offsite
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$archive_dir"
umask 077
docker compose --profile maintenance \
  run --rm postgres-backup
docker compose --profile maintenance \
  run --rm --no-deps --entrypoint sh postgres-backup -c 'ls -1 /backups'
docker compose --profile maintenance \
  run --rm --no-deps -T --entrypoint cat postgres-backup \
  /backups/moemail-2026-08-11T03-23-00Z.dump \
  > "$archive_dir/moemail-2026-08-11T03-23-00Z.dump"
docker compose --profile maintenance \
  run --rm --no-deps -T --entrypoint cat postgres-backup \
  /backups/moemail-2026-08-11T03-23-00Z.dump.config.yaml.lkg \
  > "$archive_dir/moemail-2026-08-11T03-23-00Z.dump.config.yaml.lkg"
test -s "$archive_dir/moemail-2026-08-11T03-23-00Z.dump"
test -s "$archive_dir/moemail-2026-08-11T03-23-00Z.dump.config.yaml.lkg"
```

只有上述卷外文件有效后才升级；下载并校验目标 tag 的 `postgres/docker-compose.yml`，不得下载或叠加 SQLite 文件：

```bash
set -euo pipefail
compose_ref=master
curl -fsSL \
  "https://raw.githubusercontent.com/XMZO/moemail-local/$compose_ref/postgres/docker-compose.yml" \
  -o docker-compose.yml.next
docker compose -f docker-compose.yml.next config --quiet
mv -T docker-compose.yml.next docker-compose.yml
docker compose pull
docker compose up -d
docker compose ps
docker compose --profile maintenance run --rm --no-deps verify
```

恢复前再次制作当前备份并把目标 `.dump` 与相邻 pair 放回备份目录。先打印脱敏目标，人工确认 host/port/database/user 后，才执行破坏性恢复：

```bash
set -euo pipefail
cat /srv/moemail-offsite/moemail-2026-08-11T03-23-00Z.dump | \
docker compose --profile maintenance \
  run --rm --no-deps -T --entrypoint sh postgres-backup \
  -c 'umask 077; cat > /backups/restore.dump'
cat /srv/moemail-offsite/moemail-2026-08-11T03-23-00Z.dump.config.yaml.lkg | \
docker compose --profile maintenance \
  run --rm --no-deps -T --entrypoint sh postgres-backup \
  -c 'umask 077; cat > /backups/restore.dump.config.yaml.lkg'
docker compose --profile maintenance \
  run --rm postgres-backup
docker compose --profile '*' stop
docker compose --profile maintenance \
  run --rm --no-deps --entrypoint node postgres-backup \
  /opt/moemail/config-reader.mjs --file \
  /backups/restore.dump.config.yaml.lkg postgres-target
```

此处必须暂停确认目标。确认无误后，在同一个维护窗口执行：

```bash
set -euo pipefail
docker compose up -d postgres
docker compose --profile restore \
  run --rm postgres-restore /backups/restore.dump --confirm
docker compose --profile maintenance run --rm --no-deps verify
docker compose up -d moemail
```

restore 或 verify 失败时 `set -e` 会阻止 Web 启动；成功后只恢复此前启用的 profiles。

## 5. 反向代理与 HTTPS

裸机示例位于 `deploy/local/Caddyfile` 与 `deploy/local/nginx.conf.example`。替换真实域名和证书路径，只让 Node 监听 `127.0.0.1:3000`，公网仅开放代理的 80/443。在 `data/config.yaml` 设置：

```yaml
server:
  baseUrl: https://mail.example.com
  trustProxyHeaders: true
```

OAuth 回调地址：

- GitHub：`https://mail.example.com/api/auth/callback/github`
- Google：`https://mail.example.com/api/auth/callback/google`

代理必须覆盖而不是追加 `X-MoeMail-Client-IP`、`CF-Connecting-IP`、`X-Real-IP`、`X-Forwarded-For`，并正确传递 Host/Proto。仓库示例已这样处理。普通请求体限制为 1 MB，只有 `/api/internal/email` 放宽到 27 MB；应用和 Worker 的硬限制为 25 MiB。

Compose 不再内置代理服务；宿主机上的 Caddy/Nginx 应直接反代 `127.0.0.1:3000`。仓库只保留裸机代理示例，不再提供 Docker 内置 Caddy profile。

用户名密码注册/登录即使关闭 Turnstile，也会受 `auth.rateLimit` 限制。多实例仍需在可信入口增加共享限流；应用内计数只覆盖单进程。

## 6. 入站邮件：Worker、Mailu 或外部 IMAP

每个邮箱域在“个人中心 → 域名收发”中独立选择一种收件方式。一个域不能同时走两个入口；切换时应先完成外部 Email Routing 或邮局 catch-all 配置，再观察旧入口重试结束。收件权限、每日收件额度和单封大小上限在“权限配额”中按角色或用户设置。

Cloudflare Worker 适合已经使用 Cloudflare Email Routing、希望隐藏源站或需要 R2 + Queue 缓冲的部署；Mailu 集成适合已经自托管完整邮件服务器、希望自动维护真实邮箱地址别名并同时发信的部署；通用外部 IMAP 适合其他已有企业邮局/catch-all 邮箱的部署。后两者都是 MoeMail 主动出站连接，宿主无需为 MoeMail 开放邮件端口。

### 6.1 直连模式

```bash
cp wrangler.email.example.json wrangler.email.json
```

在 `wrangler.email.json` 的 Worker `vars` 中设置公网投递 URL：

```json
{
  "vars": {
    "EMAIL_INGEST_URL": "https://mail.example.com/api/internal/email"
  }
}
```

从首次向导成功页或 `data/config.yaml` 的 `email.ingestSecret` 取得本地生成值。Secret 只通过 Wrangler 上传，不写进 Wrangler JSON：

```bash
pnpm exec wrangler secret put EMAIL_INGEST_SECRET --config wrangler.email.json
pnpm deploy:email
```

然后在 Cloudflare Email Routing 将 catch-all 或目标地址指向该 Worker。直连模式下，本地返回非 2xx 或网络超时会使 Worker 明确失败，但不承诺本地离线期间的耐久重试。

### 6.2 R2 + Queue 耐久模式

```bash
pnpm exec wrangler r2 bucket create moemail-email-buffer
pnpm exec wrangler queues create moemail-email-delivery
pnpm exec wrangler queues create moemail-email-delivery-dlq
cp wrangler.email.durable.example.json wrangler.email.durable.json
pnpm exec wrangler secret put EMAIL_INGEST_SECRET --config wrangler.email.durable.json
pnpm deploy:email:durable
```

同时在 durable Wrangler 配置的 `vars` 修改 `EMAIL_INGEST_URL`。该模式先把原始 RFC822 与 envelope metadata 写入 R2，再投递 Queue；本地成功返回 2xx 后才删除对象。scheduled handler 会补投 `pending/`，达到最大次数后移入 `failed/`。应监控 Worker error、Queue backlog 和 `failed/`，不要给 `pending/` 配置短生命周期删除规则。

Worker URL 必须是公网 HTTPS 地址，不能写 Compose service 名。本地 YAML 和 Wrangler Secret 的 `EMAIL_INGEST_SECRET` 必须完全相同。Wrangler 自己的登录态/API token 仅属于 Cloudflare 工具边界，本地 Web/API 不读取。

### 6.3 Mailu API + IMAP/SMTP 集成

该模式连接一个单独部署的 Mailu，不会把 Mailu 服务塞进 MoeMail Compose，也不会修改 Mailu 源码。Mailu 必须先完成域名、MX、TLS、DKIM/SPF/DMARC、存储和备份部署，并启用 REST API：`API=true`、通过 HTTPS 暴露所配置的 `WEB_API`，同时设置强随机 `API_TOKEN`。尽量在防火墙或私网中只允许 MoeMail 主机访问 API。Mailu 的 v1 基础地址通常是 `https://mail.example.com/api/v1`。

在 MoeMail **个人中心 → 域名收发 → Mailu 集成**：

1. 填入 v1 API 地址和 Token；填入 Mailu 的 IMAP/SMTP 主机、端口、TLS 与证书校验方式。
2. 准备两个不同且所在域已存在于 Mailu 的服务账号地址，使用强随机密码。collector 用于 IMAP 和 SMTP；catch-all 账号只转发，MoeMail 会强制将其设为禁止登录。
3. “测试 API”后用“发现域名”审阅结果；发现操作不会改域名草稿，必须点击“添加域名”并保存。目标域也必须预先存在于 Mailu。
4. 为目标域选择 Mailu 收件和/或 Mailu 发件，保存后点击“立即协调”。

协调只管理带当前随机 `integrationId` 所有权标记的对象：一个 IMAP/SMTP collector、一个禁用登录的转发账号、有效收件地址及当前获准发件地址的精确别名，以及可选的 `%@domain` catch-all 别名。只有地址所属用户同时拥有 MoeMail 发件权限和该域发件权时，精确别名才指向 collector；仅收件或被撤销发件权的地址指向禁用登录的转发账号。权限撤销、角色变化、用户/邮箱删除和过期都会触发或由周期协调收口；任何仍指向 collector 的失效受管别名都会删除，即使关闭了普通的“移除过期别名”。外部已有用户/别名同名时会拒绝，不覆盖。不要手工移除或改写这些 ownership comment。

Mailu 默认 Sieve 会清洗来信自带的 `Delivered-To`，再从第二个 `Received ... for <recipient>` 写入真实 SMTP envelope 收件人。MoeMail 只接受这一个明确配置的投递 Header，不使用 MIME `To`/`Cc`；重复或畸形 Header 会安全跳过并让邮件留在 Mailu。发件时，MoeMail API 先校验调用者拥有仍有效的本地邮箱，再确认 Mailu 中有指向 collector 的精确受管别名；`allow_spoofing` 始终为 false，通配别名不会授权任意 From。

收件默认使用 `IMAP IDLE` 长连接。Mailu/Dovecot 在新邮件写入 collector 后发送 `EXISTS` 通知，MoeMail 立即触发同一套数据库租约、UID 游标和幂等入库流程；连接断开时按可配置的指数退避范围自动重连。WebUI 可关闭实时模式或自动重连，并设置 15–86400 秒的完整轮询兜底；“高级连接与性能”还能调整连接超时、IDLE 续期、重连上下限和单轮批次。兜底会补偿通知丢失、短时断线和单轮批次上限。服务器未声明 IDLE 能力时自动保持纯轮询。IDLE 监听连接始终只读，删除/归档只由另一个持租约的短连接执行；不需要新增 Compose profile、入站端口或 Mailu 插件。

默认上游策略是在 MoeMail 数据库成功提交邮件 24 小时后从 Mailu 删除，也可改为保留、移动到归档文件夹或设更短延迟。只有 `created` 或已由内容摘要证明的 `duplicate` 才会进入删除/移动队列；未知邮箱、权限/额度拒绝、格式错误和超大邮件均留在上游。游标、待处理保留动作和短租约存储在数据库中，多进程不会并行处理同一 collector。删除要求 `UIDPLUS`，移动要求原生 `MOVE` 或 `UIDPLUS`；缺少安全 UID 范围能力时任务会失败并保留邮件，不会发送可能清除其他客户端邮件的普通 `EXPUNGE`。

两个服务账号密码启用后不能直接覆盖，应使用界面的随机轮换按钮；操作先更新 Mailu，再提交本地密钥，本地提交失败时会尽力回滚远端。Mailu API Token 与服务密码保存在 MoeMail 当前数据库中并进入数据库备份，应按密钥材料保护。

关闭 Mailu 集成会停止实时接收、兜底轮询、发信和自动协调，但不会直接删除远端账号或别名。若需要清理受管别名，先把相关域切换到其他模式并保存，再执行最后一次协调。Mailu 的精确别名同时参与 SMTP sender-login 与收件路由，所以“仅 Mailu 发件”的地址仍可能把外部来信送入 collector；建议同时启用 Mailu 收件，或为 collector 建立独立监控/清理策略。当前生产部署契约是单 Web 实例，collector 的实时通知和兜底轮询共同使用数据库租约避免重复执行。

### 6.4 外部邮局 IMAP

1. 在域名 DNS/MX 与邮局控制台启用 catch-all/全域收件，或配置覆盖所有 MoeMail 地址的别名规则，让邮件进入一个专用外部邮箱。
2. 确认邮局会清洗同名入站 Header，并把可信的 `X-Original-To`、`Envelope-To`、`X-Envelope-To` 或 `Delivered-To` 放在最前。应用不接受发件人可控的普通 MIME `To`；若邮局不保证投递追踪 Header 的来源和顺序，就不能安全确定实际临时地址，应改用 Worker。
3. 在 WebUI 把目标域改为“外部邮箱 IMAP”，填写主机、端口、`TLS`/`STARTTLS`、用户名、密码或应用专用密码、文件夹和收件 Header；公共邮局应保持严格证书校验。
4. 点击“测试 IMAP 连接”；结果会明确显示服务器是否声明 `IDLE`。保存后默认首次建立当前 UID 水位，只接收后续新邮件；确需导入现有邮件时选择“同时导入未读邮件”。WebUI 新建策略默认启用实时接收，既有普通 IMAP 策略保持纯轮询，需管理员主动打开开关。

Web 进程每 5 秒检查策略并先建立一次 UID 基线。启用实时模式时会检查 IMAP `CAPABILITY`：有 `IDLE` 就保持只读监听，新 `EXISTS` 通知只负责唤醒原有的受限轮询/幂等入库路径；无 `IDLE` 则不反复探测，自动维持纯轮询。连接断开可在 1–300 秒的可配置范围内指数退避重连；连接超时可设 5–120 秒，IDLE 续期可设 60–1740 秒。

每个账号设置的 15–86400 秒完整轮询始终运行，确保漏通知、服务器不支持 IDLE、断线和 MoeMail 停机窗口最终都会被扫描。最多同时运行 32 个只读 IDLE 监听和 4 个账号轮询；超过监听上限的账号继续由轮询完整覆盖，不会无限增加连接或并发。每个账号单轮上限可设置为 1–1000 封，积压批次会立即继续排队。读取使用只读 `EXAMINE` 和 `BODY.PEEK`，不会设置 `\\Seen`、移动或删除上游邮件；单封原始邮件硬限制 25 MiB，连接、问候和空闲读取都有超时及响应内存上限。

进度以账号指纹、IMAP `UIDVALIDITY` 和最后完成的 UID 保存在数据库。进程在“下载后、更新游标前”退出时会再次看到同一 UID，但原始内容摘要会阻止重复入库/Webhook。修改账号、主机或文件夹会建立新游标；删除或停用域会清理对应游标。两种部署都使用 `docker compose logs -f moemail` 查看日志。

IMAP 只是读取邮局中已经收到的信，不能替代 MX/catch-all，也不会在外部邮局自动创建 MoeMail 的临时地址。若服务商不支持全域收件或不保留原始收件人，请使用 Worker 模式。

### 6.5 按域外部发件

每个域在同一“域名收发”面板独立选择 Mailu 集成、Resend、外部 SMTP 或关闭发件。Mailu 模式使用 6.3 节的全局 collector 与精确别名；Resend 填该域专用 API Key；SMTP 填外部邮局主机、端口、TLS/STARTTLS、用户名/密码或应用专用密码和可选 From name，并选择自动协商、强制 PLAIN 或强制 LOGIN。现有配置默认补为“自动协商”；Microsoft/Outlook 等仍允许密码式 SMTP AUTH 但协商失败时可选 LOGIN。OAuth-only 的 Microsoft 365 租户不能靠 LOGIN 兼容，应改用支持 OAuth 的 SMTP 中继/发件服务。点击“测试 SMTP 连接”只执行 transport verify，不发送测试邮件。真正发件仍以 MoeMail 当前地址作为 From，因此必须先在服务商验证域名并完成其要求的 SPF/DKIM/DMARC。

普通多收件人发信会让所有地址出现在同一个 `To` Header。拥有“隐藏收件人并独立投递”权限时，可在 Web 发信框打开开关，或在 `POST /api/emails/{emailId}/send` 的 JSON 中传 `privateRecipients: true`；服务端会再次验权并按每个去重后的收件人分别提交，任何一封都不会暴露其他地址。无论是否独立投递，额度都按去重后的实际收件人数计算。

这些 IMAP/SMTP/Resend 凭据和 IMAP 游标保存在数据库 `site_config`，会随数据库备份和异地副本一起导出。备份文件必须保持 `0600`、加密传输并限制 rclone remote 权限；不要把凭据复制到 Compose、`.env` 或公开日志。供应商退信、限流和滥用策略属于外部边界，上线前应对每个启用的域各发送一封真实测试邮件。

## 7. systemd 与周期任务

服务工作目录固定为 `/opt/moemail`，因此权威配置路径是 `/opt/moemail/data/config.yaml`；`data/` 不能被替换成未挂载的 systemd StateDirectory。

```bash
sudo useradd --system --home /var/lib/moemail --create-home --shell /usr/sbin/nologin moemail
sudo git clone --branch v0.19.7 --depth 1 https://github.com/XMZO/moemail-local.git /opt/moemail
sudo chown -R moemail:moemail /opt/moemail /var/lib/moemail
sudo -H -u moemail sh -c 'cd /opt/moemail && /usr/bin/pnpm install --frozen-lockfile && /usr/bin/pnpm build'
sudo install -d -m 0700 -o moemail -g moemail \
  /opt/moemail/data /opt/moemail/data/backups /opt/moemail/data/postgres-backups
sudo install -d -m 0750 -o moemail -g moemail /var/log/moemail
sudo chown -R moemail:moemail /opt/moemail

sudo cp /opt/moemail/deploy/local/moemail.service /etc/systemd/system/
sudo cp /opt/moemail/deploy/local/moemail-cleanup.service /etc/systemd/system/
sudo cp /opt/moemail/deploy/local/moemail-backup.service /etc/systemd/system/
sudo cp /opt/moemail/deploy/local/moemail-monitor.service /etc/systemd/system/
sudo cp /opt/moemail/deploy/local/moemail-scheduler.service /etc/systemd/system/
sudo cp /opt/moemail/deploy/local/moemail-alert@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now moemail.service
```

上面的 clone 适用于全新安装；若代码已在别处，请先以可审计方式把完整 checkout 安装到 `/opt/moemail`，再以 `moemail` 身份完成 install/build。不要只创建空的 `/opt/moemail/data` 就启动 unit；所有 unit 的 `WorkingDirectory` 都是 `/opt/moemail`。

首次访问后，用 `sudo -u moemail cat /opt/moemail/data/setup-token` 或 `journalctl -u moemail` 取得初始化令牌。WebUI 完成并确认健康后，再启用常驻 scheduler：

```bash
sudo systemctl enable --now moemail-scheduler.service
```

unit 不含 `EnvironmentFile`，所有命令读取 `data/config.yaml`；scheduler 只读取 Web 已验证的 `.lkg`，约每 5 秒应用 cleanup、backup、monitor 与 offsite 周期变化。按目标机实际 pnpm 路径调整 `ExecStart`。

Cleanup 使用 SQLite 文件锁或 PostgreSQL advisory lock，按 `message_share → message → email_share → email` 分批删除。上限来自 `cleanup.batchSize` 和 `cleanup.maxRows`；`cleanup.permanentMessageRetentionDays` 大于 0 时也会删除永久邮箱中的过期历史消息。

## 8. 备份、恢复与异地同步

裸机命令都从 YAML 自动选择数据库，无需在 shell 前加数据库变量：

```bash
pnpm db:verify
pnpm db:backup
pnpm monitor
pnpm backup:offsite
```

SQLite 在线备份先写临时文件并运行 `integrity_check`/`foreign_key_check`，通过后原子改名。PostgreSQL 使用 custom format 并以 `pg_restore --list` 校验。

恢复必须停止 Web、常驻 scheduler 和仍在执行的 oneshot service。先用当前配置生成独立安全备份并保存现有 YAML；把数据库备份及其 pair 放到 `data/**` 之外、仅 `moemail` 用户可读的同一目录。恢复器在成功前保持当前配置不动，失败时回滚数据库与旧配置，成功后才安装所选 pair：

```bash
set -euo pipefail
scheduler_was_active=false
if sudo systemctl is-active --quiet moemail-scheduler.service; then
  scheduler_was_active=true
fi
sudo systemctl stop \
  moemail.service moemail-scheduler.service \
  moemail-cleanup.service moemail-backup.service moemail-monitor.service

sudo -u moemail sh -ceu 'cd /opt/moemail; umask 077; /usr/bin/pnpm db:backup'
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
if sudo test -f /opt/moemail/data/config.yaml; then
  sudo cp -p /opt/moemail/data/config.yaml "/opt/moemail/data/config.yaml.before-restore-$stamp"
fi
if sudo test -f /opt/moemail/data/config.yaml.lkg; then
  sudo cp -p /opt/moemail/data/config.yaml.lkg "/opt/moemail/data/config.yaml.lkg.before-restore-$stamp"
fi

sudo install -d -m 0700 -o moemail -g moemail /var/lib/moemail-restore-input
```

所选 pair 选择 SQLite 时，在同一 shell 中安装数据库与相邻 pair，然后恢复、校验；只有此前 active 的 scheduler 才会重新启动：

```bash
set -euo pipefail
sudo install -m 0600 -o moemail -g moemail \
  /path/to/moemail-backup.db /var/lib/moemail-restore-input/restore.db
sudo install -m 0600 -o moemail -g moemail \
  /path/to/moemail-backup.db.config.yaml.lkg \
  /var/lib/moemail-restore-input/restore.db.config.yaml.lkg
sudo -u moemail sh -ceu 'cd /opt/moemail; umask 077; /usr/bin/pnpm db:sqlite:restore /var/lib/moemail-restore-input/restore.db --force'
sudo -u moemail sh -ceu 'cd /opt/moemail; /usr/bin/pnpm db:sqlite:verify'
sudo systemctl start moemail.service
if "$scheduler_was_active"; then sudo systemctl start moemail-scheduler.service; fi
```

所选 pair 选择 PostgreSQL 时，改为安装 `.dump` 与 pair，并先单独打印脱敏目标：

```bash
set -euo pipefail
sudo install -m 0600 -o moemail -g moemail \
  /path/to/moemail-backup.dump /var/lib/moemail-restore-input/restore.dump
sudo install -m 0600 -o moemail -g moemail \
  /path/to/moemail-backup.dump.config.yaml.lkg \
  /var/lib/moemail-restore-input/restore.dump.config.yaml.lkg
sudo -u moemail sh -ceu 'cd /opt/moemail; node deploy/docker/config-reader.mjs --file /var/lib/moemail-restore-input/restore.dump.config.yaml.lkg postgres-target'
```

此处暂停。人工确认 host/port/database/user 后，才单独执行恢复块；失败时 `set -e` 不会启动服务：

```bash
set -euo pipefail
sudo -u moemail sh -ceu 'cd /opt/moemail; umask 077; /usr/bin/pnpm db:postgres:restore /var/lib/moemail-restore-input/restore.dump --force'
sudo -u moemail sh -ceu 'cd /opt/moemail; /usr/bin/pnpm db:postgres:verify'
sudo systemctl start moemail.service
if "$scheduler_was_active"; then sudo systemctl start moemail-scheduler.service; fi
```

SQLite 恢复会把旧数据库改名为带时间戳的 `.bak`；PostgreSQL 恢复前会先制作 `pre-restore-*` safety backup。这些 safety 文件只服务本次本地自动回滚，刻意不附加配置 pair，也不会上传 offsite 或自动保留清理；确认新恢复点稳定后由管理员显式归档或删除。`offsite.remote` 配好后，`pnpm backup:offsite` 使用 checksum + immutable 复制最新数据库备份，并以同一备份文件名附加 `.config.yaml.lkg` 上传配对的已验证配置快照；凭据可由 `offsite.rcloneConfigContent` 提供。配置快照含全部密钥，强烈建议使用 rclone crypt remote，并定期在独立目录做完整恢复演练。

数据库文件/归档本身不包含运行配置。内置备份命令会在旁边原子生成同名 `.config.yaml.lkg` pair；导出时必须两者一起加密保存，并另行保留主 `config.yaml` 供审计。否则会丢失会话、密码 pepper 与 Worker 投递 secret。不要用损坏的主配置覆盖 LKG 或 pair。

恢复到全新 Compose 独立目录时，不要先启动 Web。数据库备份旁边必须存在同名 `.config.yaml.lkg`。恢复演练必须建立独立目录，并且只复制与备份数据库一致的 `docker-compose.yml`；不要叠加两种部署。不要把宿主密钥文件改成 0644，也不要假设宿主 UID 等于容器 UID 10001；先以 root 一次性容器把 `0600` 输入复制到临时卷并改属 10001，再把该卷只读挂载到 `/restore`。不要先复制到可配置的 `data/**` 目标。恢复器在数据库校验成功后自行安装 pair。

SQLite 的完整顺序如下。宿主 `restore-point/` 同时包含 `.db` 与相邻 pair；容器内 `/restore` 位于工作目录的 `data/` 之外，因此不可能与任意合法 live path 相同。示例刻意使用全新的独立目录；恢复后的所有管理命令都必须继续在同一个 `recovery_root` 下执行：

```bash
set -euo pipefail
recovery_project="moemail-recovery-$(date -u +%Y%m%d%H%M%S)"
restore_root="$(pwd)/restore-point"
recovery_root="$(pwd)/$recovery_project"
mkdir -p "$recovery_root"
cp docker-compose.yml "$recovery_root/docker-compose.yml"
cd "$recovery_root"
mkdir -p data
docker compose -p "$recovery_project" run --rm storage-init
restore_input="moemail-restore-input-$(date -u +%Y%m%d%H%M%S)-$$"
docker volume create "$restore_input"
docker compose -p "$recovery_project" run --rm --no-deps --user 0:0 \
  --volume "$restore_root:/source:ro" --volume "$restore_input:/restore" \
  --entrypoint sh moemail -ceu '
    chown 10001:10001 /restore && chmod 0700 /restore
    install -o 10001 -g 10001 -m 0600 /source/moemail-2026-08-11T03-23-00.000Z.db /restore/restore.db
    install -o 10001 -g 10001 -m 0600 /source/moemail-2026-08-11T03-23-00.000Z.db.config.yaml.lkg /restore/restore.db.config.yaml.lkg
  '
docker compose -p "$recovery_project" --profile restore run --rm --no-deps \
  --volume "$restore_input:/restore:ro" \
  restore /restore/restore.db --force
docker compose -p "$recovery_project" --profile maintenance run --rm --no-deps verify
```

verify 成功后，先停止或切走同宿主仍占用 3000 端口的旧 Web，再执行 `docker compose -p "$recovery_project" up -d moemail`；确认新实例健康后才能运行 `docker volume rm "$restore_input"`。任何一步失败时 `set -e` 会停止，保留临时输入卷和独立恢复目录供排错，不会启动 Web 或删除原部署。

恢复内置 PostgreSQL 新目录前，先确认配对快照中的 driver 是 `postgres`，URL 正是预期目标 `postgresql://moemail@postgres:5432/moemail`；若 URL 指向托管库，恢复器会操作该外部库，而不是新的 `./data/postgres`。下例同样使用隔离的全新目录；恢复后继续在同一 `recovery_root` 下管理它：

```bash
set -euo pipefail
recovery_project="moemail-pg-recovery-$(date -u +%Y%m%d%H%M%S)"
restore_root="$(pwd)/restore-point"
recovery_root="$(pwd)/$recovery_project"
mkdir -p "$recovery_root"
cp docker-compose.yml "$recovery_root/docker-compose.yml"
cd "$recovery_root"
mkdir -p data data/postgres data/postgres-backups
restore_input="moemail-restore-input-$(date -u +%Y%m%d%H%M%S)-$$"
docker volume create "$restore_input"
docker compose -p "$recovery_project" \
  run --rm --no-deps --user 0:0 \
  --volume "$restore_root:/source:ro" --volume "$restore_input:/restore" \
  --entrypoint sh moemail -ceu '
    chown 10001:10001 /restore && chmod 0700 /restore
    install -o 10001 -g 10001 -m 0600 /source/moemail-2026-08-11T03-23-00Z.dump /restore/restore.dump
    install -o 10001 -g 10001 -m 0600 /source/moemail-2026-08-11T03-23-00Z.dump.config.yaml.lkg /restore/restore.dump.config.yaml.lkg
  '
docker compose -p "$recovery_project" --profile maintenance \
  run --rm --no-deps --volume "$restore_input:/restore:ro" \
  --entrypoint node postgres-backup /opt/moemail/config-reader.mjs \
  --file /restore/restore.dump.config.yaml.lkg postgres-target
```

此处必须暂停并人工确认脱敏目标，特别是 host/database；不要把下一个代码块与目标检查合并粘贴。确认后在同一 shell 中继续：

```bash
set -euo pipefail
docker compose -p "$recovery_project" up -d postgres
docker compose -p "$recovery_project" --profile restore \
  run --rm --volume "$restore_input:/restore:ro" postgres-restore \
  /restore/restore.dump --confirm
docker compose -p "$recovery_project" --profile maintenance \
  run --rm --no-deps verify
```

verify 成功后，先停止或切走同宿主旧 Web，再执行 `docker compose -p "$recovery_project" up -d moemail`；确认健康后才能删除 `$restore_input`。失败时保留恢复目录和输入卷，不要启动 Web。

裸机新目录把数据库备份及相邻 pair 以 `0600` 安装到 `/var/lib/moemail-restore-input/`（或其他 `/opt/moemail/data` 之外的 0700 目录），再以 `moemail` 用户执行恢复；不要预写 `config.yaml(.lkg)`。配置与数据库必须来自同一恢复点，恢复后先 verify 再开放流量。跨版本灾备优先用产出该备份的同版本代码/镜像恢复并 verify，再逐步升级和 migration；不要直接假定未来版本的完整 schema 校验能接受任意历史归档。

## 9. 从 D1/KV 切换

先保留原始导出并进入维护窗口：

```bash
pnpm exec wrangler d1 export DATABASE_NAME --remote --output d1-export.sql
sqlite3 d1-source.db < d1-export.sql
```

先通过 WebUI 选择目标数据库并完成初始化，再停止 Web/维护任务并导入。向导已经创建了初始皇帝，目标业务表不是空库，因此确认备份无误后显式使用 `--force` 替换目标业务数据：

```bash
# YAML 当前选择 SQLite
pnpm db:sqlite:import-d1 d1-source.db --force
pnpm db:sqlite:verify

# YAML 当前选择 PostgreSQL 时改用
# pnpm db:postgres:import-d1 d1-source.db --force
# pnpm db:postgres:verify
```

导入器会检查时间范围、外键、正文 hash、安全 ASCII mailbox、大小写重复地址和多皇帝冲突；失败不会留下部分导入。若旧用户密码是 44 字符 SHA-256 格式，必须把旧部署的会话 secret 填入 `auth.secret`，直到用户登录完成惰性升级或管理员统一重置密码。`auth.passwordPepper` 不要随意更换。

把旧 KV 站点设置整理为对象或 `{ "key", "value" }` 数组，然后运行统一入口：

```bash
pnpm db:import-config kv-config.json
```

默认不覆盖已存在键；核对后可加 `--force`。最后抽查用户、角色、邮箱、正文、分享、Webhook、API Key 和站点设置。

## 10. 合并官方更新

仓库约定 `origin` 指向本地化 fork，`upstream` 只读指向官方仓库：

```bash
git fetch upstream --tags
git switch feat/local-deployment
git rebase upstream/master
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm validate:no-local-env
pnpm validate:runtime-config
pnpm validate:runtime-config:cold
pnpm validate:setup
pnpm validate:setup:http
pnpm validate:email-worker
pnpm validate:mail-policies
pnpm validate:imap-inbound
pnpm validate:mailu
pnpm validate:runtime-fields
# 目标机装有 PostgreSQL 客户端/服务端工具时：
pnpm validate:setup:http:postgres
pnpm validate:scheduler
pnpm validate:rclone-config
pnpm validate:restore
pnpm validate:deployment
pnpm build
```

优先保留 `app/lib/config/`、首次初始化向导、动态数据库 facade 与本地 migration。每次同步重点检查官方新增的 Edge Runtime、`getRequestContext()`、D1/KV 直接调用、schema/migration、Email Worker 字段和 cleanup 语义。不要把 `drizzle-local/`、`drizzle-postgres/` 与官方 `drizzle/` 合成一条迁移链。

## 11. 上线检查

- 全新空数据目录启动后只能凭一次性 token 完成初始化；成功后 token 文件删除，第二次 setup 被拒绝。
- WebUI 能选择 SQLite/PostgreSQL、创建唯一皇帝并生成 `data/config.yaml`；重启仍读取同一配置。
- 直接修改 YAML 与 WebUI 保存都能应用；故意写坏 YAML、越界字段和不可达数据库时，旧配置继续服务且错误可见。
- 切换数据库类型后守护进程拉起新进程，health 返回目标 driver；同类型连接参数变化无需重启。
- 登录、邮箱、收信、详情、分享、角色、API Key、Webhook、配置和发件正常。
- 每个域的入站 Worker/IMAP 与出站 Resend/SMTP/关闭选择分别生效；错误入口不会绕过域策略。
- 角色与用户覆盖的功能权限、邮箱数/有效期/每日收发/大小额度生效；皇帝自身权限不可编辑。
- 错误 ingestion secret 返回 401，超大请求返回 413，重复邮件只入库一次。
- `pnpm db:verify` 成功；数据库备份及其相邻 `.config.yaml.lkg` pair 能在全新独立路径恢复。
- 监控磁盘、数据库/WAL 大小、HTTP 5xx、ingestion 非 2xx、cleanup 退出码和 API 延迟。
- Compose 部署确认容器 health、非 root 用户、同目录 bind mounts 可完整打包迁移，且 migration 失败时不提交候选配置。
- durable Worker 的 Queue backlog 为零，R2 `failed/` 无未处理对象。
