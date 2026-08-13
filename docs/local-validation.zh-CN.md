# 本地化改造验证记录

验证日期：2026-08-13。SQLite/Next.js 主开发验证环境为 Windows、Node.js 24.14.0、pnpm 11.21.0、better-sqlite3 12.4.1（SQLite 3.50.4）；PostgreSQL 使用独立临时 PostgreSQL 18 集群。另在 Debian 13 x86_64 VPS、Docker 29.7.2、Compose 5.4.0 上完成 SQLite 镜像实机部署。生产部署仍应在自己的目标机重做恢复演练。

## 构建与静态检查

- `pnpm install --frozen-lockfile --offline`：通过。
- `pnpm exec tsc --noEmit --incremental false`：通过。
- `pnpm lint`：通过，无 warning 或 error。
- `pnpm build`：Next.js 15.5.23 production build 通过，Node Route、middleware、PWA 与页面均成功生成。
- `git diff --check`：通过。
- Web 运行源码未发现 `runtime = "edge"`、`getRequestContext()`、`SITE_CONFIG`、`drizzle-orm/d1` 或 `env.DB` 残留；旧 Pages/D1/Cleanup Worker 部署资产已从当前运行分支删除，D1 只保留离线数据导入工具。
- 两份 Compose 文件均通过 YAML 与部署契约解析；`sqlite/docker-compose.yml` 是不含 PostgreSQL 服务或镜像的 SQLite 部署，`postgres/docker-compose.yml` 是独立的内置 PostgreSQL 部署。仓库根目录刻意不放默认 Compose 文件；进入所选目录后均可直接使用 `docker compose`，相邻 `./data` 也天然隔离。二者均无 `environment`/`env_file`、无 `${...}` 宿主插值、无本地 `build`、无 Docker 内置 Caddy。systemd units 无 `EnvironmentFile`。PostgreSQL backup scheduler 会在首次 dump 前等待完整数据库 schema，Docker restore 使用单事务；工具 sidecar 同时具备内置隔离网络与外部数据库出口。
- `pnpm validate:no-local-env` 通过：递归检查两份 Compose、`app/**` 与 systemd services，确认没有本地应用环境配置入口，并确认 `.env.example` 已移除。
- `pnpm validate:deployment` 通过：检查互斥的 SQLite/PostgreSQL standalone Compose、轻量 Web `latest` 与按需维护 `latest-tools` 契约、PostgreSQL 隔离网络与幂等 HBA 规则、PG 18 server/工具镜像、备份/恢复并发锁、systemd 自动重启，以及 tag/手动触发的原生 amd64+arm64 GHCR 发布 workflow（无 QEMU、四种镜像变体按 digest 推送并在合并 manifest 前执行原生 smoke）。
- `pnpm validate:maintenance-bundle` 通过：构建约 1.3 MiB 的维护 dispatcher/config reader，并只携带 SQLite native binding 等必要运行文件；真实完成 SQLite setup 后由 bundle 执行 self-check、完整 schema verify、原子 DB+LKG 配对备份和 cleanup。工具镜像不再继承 Web 文件，也不需要 Next、pnpm、tsx、TypeScript 或完整应用源码。
- `v0.16.6` 的 [Publish Docker Images](https://github.com/XMZO/moemail-local/actions/runs/31595636029) 在原生 amd64/arm64 runner 上全部通过。Web smoke 实际启动 standalone server、health、首次向导、静态文件、WOFF2 字体和 Sharp 图片优化；维护 smoke 实际加载 Linux `better-sqlite3` native binding 与 rclone。amd64 Web 压缩层由 `v0.16.5` 的 290.54 MiB 降至 106.65 MiB（-63.3%），arm64 由 285.94 MiB 降至 107.17 MiB（-62.5%）；未压缩分别为 316.90/335.72 MiB，冷启动为 2/1 秒。按需维护镜像压缩后为 95.79/94.19 MiB，未压缩为 275.92/293.07 MiB。四种 `latest`/`latest-tools` 均与本次 version tag 的 OCI index digest 一致并包含 linux/amd64、linux/arm64。
- `pnpm validate:email-worker` 通过：直连 Email Worker 使用 Cloudflare Workers 支持的 `redirect: "manual"`，并对模拟 302 保持 fail-closed，不会把投递 Secret 或原始邮件跟随到其他 Origin。
- `pnpm validate:mail-policies` 通过：每个域可独立选择 Worker/IMAP/关闭收件和 Resend/SMTP/关闭发件，Resend 请求与真实 TCP SMTP `verify`/AUTH/发件使用各域自己的凭据；旧 SMTP 配置默认迁移为自动协商，另一个真实 TCP SMTP 会话验证强制 `AUTH LOGIN` 的用户名/密码挑战流程；角色与单用户覆盖的权限、邮箱数量、有效期、每日收发和消息大小额度按预期合并，皇帝策略固定为全权限且不限额。
- `pnpm validate:send-quota` 通过：四种角色与单用户可分别配置收件/发件总量、单域名、每邮箱滚动窗口与每邮箱生命周期上限（秒、分、时、日、周、30 天月）；验证 `-1` 不限、`0` 禁止、总量与域名上限交集、角色共享/按用户统计、并发原子预留、失败释放、崩溃租约回收、删除重建邮箱不能规避生命周期额度、管理员精确重置，以及用户删除后审计历史保留。
- `pnpm validate:policy-migrations` 通过：从上一版仅发件额度的 SQLite schema 实际迁移到双向邮件额度和邮箱名封禁结构，旧审计事件完整保留并回填为 `send`，新增约束、索引、外键及 Drizzle journal 全部通过完整性检查。
- `pnpm validate:imap-inbound` 通过：在隔离 SQLite 数据库和随机 TCP 端口上完成真实 IMAP 登录、只读 mailbox、UID SEARCH/FETCH 对话；`X-Original-To` 正确映射到本地邮箱，伪造的 MIME `To` 不会旁路投递，原始 RFC822 入库，持久 UID 游标和 UIDVALIDITY 重置重扫都保持幂等，且客户端从未发送 STORE/MOVE/COPY/EXPUNGE。同一验证器也在临时 PostgreSQL 18 数据库、`poolMax=1` 下通过，短事务租约不会长期占住唯一连接。
- `pnpm validate:runtime-fields` 通过：视觉运行配置编辑器的 metadata 与当前 strict schema 的全部叶字段一一对应，无缺项或幽灵字段；视觉/YAML 切换会同步草稿，字段可单独恢复默认值。
- `pnpm validate:i18n` 通过：`en`、`zh-CN`、`zh-TW`、`ja`、`ko` 的 11 个独立消息模块叶子键完全一致；59 个运行配置字段均有五语标签和说明，首次向导有五套完整词典。自动门禁扫描 89 个 UI/Hook 文件、39 个 API 路由与 52 个核心后端文件：禁止写死中日韩文案、英文 JSX/无障碍属性、自然语言 API 错误/日志、直接回显 `Error.message`，并禁止在翻译调用外拼接固定标点、列表分隔符或自然语言片段；API 只返回已注册机器码，客户端从五语 `api.json` 翻译。角色名只在 `profile.card.roles` 词典中维护，验证代码不再复制任何语言的译文；语言导航保留路径、查询参数、锚点和管理面板 `tab` 状态，Auth.js 登录与错误兜底页同样由五语词典渲染。
- `pnpm validate:runtime-config` 通过：损坏 YAML、未知字段、不可打开或没有站主的 SQLite 目标均被拒绝且旧值继续生效；有效直接文件修改由约 1 秒 watcher 自动应用。进程内 revision 竞争、外部文件 fingerprint 失效，以及两个真实 Node 进程同时持同一 fingerprint 保存都恰好一个成功；跨进程保存锁在退出后无残留。
- `pnpm validate:runtime-config:cold` 通过：首份配置、主文件与 LKG 相同、以及仅剩 LKG 三种路径都必须重新验证数据库中恰有一个站主后才开放完成态；不可读目标、空库与无站主 LKG 均被拒绝且不会创建目标文件。坏 PostgreSQL 主配置回退 SQLite LKG 时，实际绑定 driver 与维护 CLI 也只使用已验证的 SQLite 配置。坏配置仍允许 Web 恢复入口启动。
- `pnpm validate:setup` 通过：首次 SQLite setup、已暂存 pepper 的同账号续跑、不同既有站主 409、两个真实 Node 进程争用同一 setup operation lock，以及坏 YAML/非对象 payload 拒绝均通过；另覆盖进程 A 完成后进程 B 持旧内存 token 的顺序竞争，B 在取锁后重新加载并以 409 拒绝。该测试构造等价的 staged 状态，不冒充进程崩溃注入测试。
- `pnpm validate:scheduler` 通过：裸机常驻 scheduler 只读取已验证 `.lkg`，不会退回使用坏的主配置；Compose shell scheduler 通过 `bash -n` 并约每 5 秒重读 LKG。
- `pnpm validate:rclone-config` 通过：YAML 中的 rclone 配置只在单次调用期间写入临时文件，成功与异常路径都会删除文件及临时目录；数据库备份在归档时固化相邻 `.config.yaml.lkg`，异地任务只上传完整的正常备份配对并排除恢复前 safety backup。SQLite/PostgreSQL 保留策略都只删除可由严格 pair 证明的归档，在线库、无 pair、坏 pair 与当前目标均保留。
- `pnpm validate:restore` 通过：真实 SQLite 恢复覆盖“现有配置与恢复点不同”“旧 primary 已损坏”“来源缺少唯一站主/必需列/主键/精确表达式唯一索引时零变更失败”“只读 standalone 来源”和“全新 data 目录自举”等路径；成功后才提交 pair 并删除 setup token，失败保持原数据库、primary、LKG 与 token 逐字不变，WAL 中已提交数据不会丢失，旧库 safety 文件不会伪造配置 pair。PostgreSQL Node/Docker 恢复事务在本轮通过类型检查、真实 PG 结构校验、shell 语法与部署契约验证，仍需在目标 Docker/托管 PG 环境做破坏性恢复演练。
- `pnpm start` 由 Next.js Node instrumentation 在加载业务路由前等待唯一一次冷启动校验；Docker/systemd 不再用独立预进程重复探测同一坏候选。未初始化或校验失败时仍启动 Web 恢复入口，首次访问向导时生成/复用一次性 setup token。secret 长度、占位符、重复值、认证限流和 scrypt 并发参数均由同一 schema 约束。
- 生成的 Service Worker 不含 `apis`、`others`、`start-url` 或其他运行时缓存路由，只预缓存静态资源；激活脚本会删除旧运行时 cache，且 `/api/*` 实测带 `private, no-store`。

安全审计后升级了 Next.js、next-intl、Radix UI、YAML、tsx、Tailwind/PostCSS 及相关传递依赖，并强制 Next.js 使用 Sharp 0.35.0。Auth.js beta 仍声明 Nodemailer `^7.0.7 || ^8.0.5`，但该范围受 GHSA-p6gq-j5cr-w38f 影响；项目固定已修复的 Nodemailer 9.0.5，并仅为这一项声明精确 peer 例外，真实 TCP SMTP `verify`/AUTH/发件回归通过。使用 pnpm 11.21.0 执行 `pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`，`pnpm peers check` 无其余 peer dependency 问题。

## Debian 13 VPS Docker SQLite（旧配置链路记录）

- 在 4 vCPU、3.8 GiB RAM、40 GiB SSD 的 x86_64 VPS 上，较早的环境变量版工作树曾执行 `docker compose up -d --build`，镜像构建、SQLite migration、结构 verify、运行时 secret 校验和 healthcheck 全部通过。该结果只证明旧版镜像/SQLite/调度器基础链路，不证明当前双 Compose + GHCR 镜像 + 首次 WebUI/YAML 配置链路。
- 容器以镜像声明的 UID/GID `10001` 运行，端口映射为 `0.0.0.0:3000`；公网 `GET /api/internal/health` 返回 `200` 与 `database=sqlite`，中文首页返回完整 MoeMail HTML。
- 公网 `pnpm validate:http` 通过；临时用户注册返回 `201`、响应不含密码、落库哈希为 `$scrypt$v1$`，随后已删除测试用户并确认数据库无残留。
- 在线 backup 通过完整性校验并原子生成 `.db` 文件；验证过程中发现并修复验证连接遗留 `.tmp-shm/.tmp-wal` 的问题，复测 sidecar 数量为 0。
- 容器 restart 后 migration/verify 可重复执行且 health 恢复；`scheduler` profile 已实机完成一次 cleanup 和一次启动备份，Web 与 scheduler 当前可同时稳定运行。
- 此次按用户要求使用明文 HTTP IP 直连，只适合临时测试；未把 Cloudflare Worker 的 ingestion secret 或真实账号密码放在该链路上。

## SQLite 与本地运维

- 全新空库 migration 连续执行两次成功，第二次无重复变更；schema/Drizzle tracking 共 12 张表。
- `integrity_check`、`foreign_key_check` 与 `db:sqlite:verify` 均通过。
- WAL、foreign keys、5000 ms busy timeout 与 NORMAL synchronous 在实际连接启用。
- ConfigStore 多键事务写入、进程重启后读取、冲突拒绝及 `--force` 覆盖通过。
- Cleanup 按分享、消息、邮箱分享、邮箱显式分批删除；SQLite 高关联夹具以 batch=2/maxRows=3 连续 20 轮清空 56 行，单轮最多 3 行，永久邮箱保留。
- 人工创建有效 cleanup 锁时命令返回 `cleanup.skipped`，未破坏其他容器/进程的锁。
- Web 在线期间执行 cleanup、在线 backup 和 monitor，无 `database is locked`；monitor 正确检查 health、真实磁盘、WAL 与 JSON access log。
- 在线备份先验证后原子改名；本轮备份包含 1 用户、2 邮箱、29 消息，并通过完整性校验。
- D1 导入复测校验 10 张业务表、17 个时间字段、外键和 25 条消息样本 SHA-256；29 条消息导入后 hash 一致。
- 大小写地址唯一索引通过实库验证；`Case@local.test` 与 `case@local.test` 的第二次写入被 `SQLITE_CONSTRAINT_UNIQUE` 拒绝，verify 报告 `caseInsensitiveEmailUnique=true`。
- 构造的旧 D1 源库若包含大小写重复邮箱或多个 emperor 用户，SQLite 导入分别以 `DUPLICATE_EMAIL_ADDRESS`、`MULTIPLE_EMPEROR_USERS` 明确拒绝，且目标库不产生部分写入。
- verify 同时报告 `asciiMailboxAddresses=true`；导入器在写入前以 `INVALID_EMAIL_ADDRESS` 拒绝 Unicode/空白或其他不受支持的 mailbox 地址。

## PostgreSQL 18

在工作区临时初始化、启动并最终清理的 PostgreSQL 18 集群上完成：

- migration 连续执行两次、结构 verify 通过。
- 15 项 smoke 覆盖 relations、Auth adapter、`returning()`、ConfigStore 与 20 路并发幂等插入。
- D1 导入、`--force` 覆盖、秒/毫秒转换、逐表 hash、正文 hash 与 NUL 拒绝通过。
- PostgreSQL 使用同构 56 行夹具得到相同的 20 轮/单轮最多 3 行结果；永久邮箱保留，session advisory lock 被占用时返回 `cleanup.skipped`。
- custom-format backup 校验后，执行“删除消息 → restore → verify”恢复演练通过。
- 当前 production build 已在临时 PostgreSQL 18 集群上从未初始化默认状态选择 PostgreSQL；setup 响应后进程按 `database.driver` 正常退出，测试守护逻辑拉起同一 build，health 返回 `database=postgres`，随后登录与运行配置热更新通过。
- HTTP ingestion 20 路同邮件并发得到 1 个 created、19 个 duplicate，数据库只有 1 行。
- 最新 security baseline 包含 11 张业务/配置表、完整主键/唯一约束、14 个索引和 9 个外键；Node 与 Docker verifier 均在真实临时集群通过，并会拒绝把同名唯一索引替换成普通索引。verify 报告 `caseInsensitiveEmailUnique=true`。
- `Case@Test.com` 与 `case@test.com` 的第二次写入被 PostgreSQL `23505` 拒绝，约束名为 `email_address_lower_idx`；带同类冲突的 D1 源导入以 `DUPLICATE_EMAIL_ADDRESS` 明确失败。

## HTTP、鉴权与收信

在真实 `next start` 上完成回归：

- `pnpm validate:setup:http` 在隔离临时目录验证首次 `/zh-CN → /zh-CN/setup`、setup token、SQLite 探测/migration、唯一皇帝、token 删除、Credentials 登录、皇帝运行配置读取/保存、旧 fingerprint 409、直接文件 watcher 和坏字段不应用；完成后还验证域策略保存、真实 RFC822 Worker 入库、独立关闭出站、角色策略保存、皇帝自覆盖拒绝以及字体安全校验。
- `pnpm validate:setup:http:redaction` 从仅有 staged LKG 的恢复状态启动，确认未鉴权 setup HTML 不含已存 rclone 凭据；随后删除主配置和 LKG、只保留 runtime 内存副本时仍不回显，空高级 YAML 提交后该值继续由服务端保留。
- `pnpm validate:setup:http:postgres` 启动独立临时 PostgreSQL 18 集群，复跑同一 HTTP 链路并额外验证 driver 自动退出/重启恢复；临时 Next、数据库集群和派生文件均在测试结束后删除。
- 未初始化时 auth 与公开分享 API 返回 `SETUP_REQUIRED`，health 返回 200 `setup-required`；坏冷启动配置同样保留 200 的 Web 恢复入口。损坏 secret 行使用 canary 实测，匿名 health 只返回通用错误码，响应和 runtime 错误日志均不含原始配置行。
- 匿名、伪造 `X-User-Id`、空/无效/禁用/过期 API Key 均被拒绝。
- Civilian API Key 无邮件权限；Duke 可访问邮件；Emperor 可读写完整配置。
- API Key 不能访问 Webhook、角色和 API Key 管理等 session-only 路由。
- 用户名密码注册、CSRF、Credentials 登录、Session 读取和当前角色刷新通过。
- 邮箱创建、列表、详情、删除、分享与外键级联通过。
- 原始 RFC822 的 text、HTML-only、无主题/空正文、1 MiB HTML 均成功入库。
- 错误 secret、未知邮箱、声明大小不符、超过 25 MiB 的声明和错误 Content-Type 返回预期状态。
- 相同原始邮件重放返回 duplicate；并发重放不产生重复消息。
- 20 路并发创建同一邮箱的大小写变体得到 1 个 200、19 个 409，无 500；数据库按 `LOWER(address)` 分组无重复项。
- 伪造 `X-User-Id` 创建邮箱返回 401；站主初始化不再接受 GET（405），匿名 POST 返回 401。
- 过期邮箱在 cleanup 物理删除前收信返回 ignored，数据库中没有新增消息；Unicode envelope recipient 返回 400，不会依赖 SQLite 的 ASCII-only `LOWER()` 行为。
- 新建 `Mixed.Case@LOCAL.TEST` 返回规范化的 `mixed.case@local.test`；Unicode local-part 返回 400，20 路大小写变体并发得到 1 个 200、19 个 409。
- 邮箱分享列表与详情都排除 `type=sent`：接收消息详情返回 200，同邮箱已发送消息 ID 返回 404。
- 注册成功返回 201 且响应无 password，重复用户名返回 409；数据库密码为带随机 salt 的 `$scrypt$v1$`。`pnpm validate:password` 另验证错误密码、旧 SHA-256 兼容/惰性升级、`auth.secret` 解耦与可选 pepper。
- 较早的真实 production HTTP 曾将注册/登录客户端上限临时设为 2，注册依次返回 `201/409/429`，Credentials callback 依次返回 `302/302/429`；两种 429 都带 `Retry-After` 和 `AUTH_RATE_LIMITED`。当前 `pnpm validate:auth-abuse` 已按配置对象覆盖进程全局上限、有界客户端 Map、代理头 opt-in、忽略 `X-User-Id` 与 scrypt 并发快速失败。
- Webhook 保存前和发送时均执行 SSRF 校验；loopback、private、link-local、metadata、localhost 与 IPv4-mapped IPv6 被拒绝，发送时使用已验证 IP 且不跟随重定向。

可复跑入口：`pnpm validate:no-local-env`、`pnpm validate:deployment`、`pnpm validate:maintenance-bundle`、`pnpm validate:email-worker`、`pnpm validate:mail-policies`、`pnpm validate:send-quota`、`pnpm validate:policy-migrations`、`pnpm validate:imap-inbound`、`pnpm validate:runtime-fields`、`pnpm validate:i18n`、`pnpm validate:runtime-config`、`pnpm validate:runtime-config:cold`、`pnpm validate:setup`、`pnpm validate:setup:http`、`pnpm validate:setup:http:redaction`、`pnpm validate:setup:http:postgres`、`pnpm validate:scheduler`、`pnpm validate:rclone-config`、`pnpm validate:restore`、`pnpm validate:password`、`pnpm validate:auth-abuse`。`pnpm validate:http`、`pnpm validate:ingest` 与 `pnpm load:polling` 是面向已启动部署的外部探针，分别需要目标 URL，以及显式的测试收件人/投递 secret 或负载测试凭据，不能当作无参数的自包含门禁运行。

## SQLite 轮询基线

测试邮箱包含 29 封消息，其中 25 封有约 1 KiB 正文；列表每次返回 20 条摘要。轮询响应不含 `content/html` 和 `total`，实测 4074 bytes（3.98 KiB）；首次带 `includeTotal=1` 的响应为 4085 bytes。相较优化前约 23.1 KiB，单次轮询响应减少约 83%。

每档执行 3 轮，每轮每客户端请求 3 次；下表为三轮平均值：

| 并发轮询 | 每轮请求数 | 吞吐 | p50 | p95 | p99 | 错误/SQLite busy |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50 | 150 | 514.3 req/s | 85.8 ms | 97.6 ms | 123.3 ms | 0 / 0 |
| 100 | 300 | 663.7 req/s | 129.0 ms | 150.8 ms | 225.8 ms | 0 / 0 |
| 200 | 600 | 716.6 req/s | 254.6 ms | 280.1 ms | 304.8 ms | 0 / 0 |

这是本机短时 localhost 基准，不等同于可承诺的“同时在线人数”，也不替代目标 VPS 的持续混合压测。生产容量仍按 `docs/local-deployment.zh-CN.md` 的保守区间规划，并监控 CPU、RSS、磁盘、WAL、p95、收信速率和反向代理出口带宽。

## Cloudflare Worker

以下两种保留的 Email Worker 配置使用 Wrangler 4.120.1 dry-run 均通过：

- 直连 HTTPS POST：`wrangler.email.example.json`，上传 6.37 KiB。
- R2 + Queue 耐久模式：`wrangler.email.durable.example.json`，上传 6.37 KiB，bindings/cron 配置可解析。

直连模式已在真实 Cloudflare Email Routing 上完成 MX、catch-all、Worker Secret、实时 tail 与公网 HTTPS 入库验证。验收时发现 Cloudflare 边缘运行时不实现 Fetch 的 `redirect: "error"`；现已改为 `manual`，由非 2xx 检查拒绝重定向，真实邮件复测通过。R2、Queue、DLQ 与 scheduled 恢复仍只有 dry-run，未冒充目标账号实网验收。


## 仍需部署环境验收

以下项目依赖用户的真实域名、Linux 主机、Cloudflare 账号或第三方密钥：

- GitHub/Google OAuth 完整回调、代理 Host 与 HTTPS Secure Cookie。
- Cloudflare Email Routing 的真实 MX 入信，以及 durable 模式离线/恢复演练。
- 外部 IMAP 服务商的 catch-all、原始收件人 Header、TLS/应用专用密码、UIDVALIDITY 重置、限流及停机恢复行为；自包含测试只覆盖标准 IMAP 协议和入库语义。
- 每域 Resend 与外部 SMTP 的真实发件、TLS、额度、退信和提供商限流行为。
- Turnstile 真实 token 校验。
- Caddy/Nginx 真实证书、代理头与日志权限。
- 真实浏览器点击/可访问性与移动端视觉；当前已覆盖 production HTML 和向导背后的完整 HTTP/Session API，不把 API 验收冒充浏览器自动化。
- Linux systemd `Restart=always` 与 `moemail-scheduler.service` 的实际安装、权限、进程重启；本机测试已验证相同 Next 退出/重启语义与 scheduler 的 LKG 读取。
- 当前两份 Compose 已用 Docker 官方发布并经 SHA-256 校验的 Compose v5.4.0 standalone 执行 `config --quiet`，默认配置和全部 profiles 都通过：SQLite 默认解析出 `storage-init`、`moemail`，完整配置为 10 个服务；PostgreSQL 默认解析出 `storage-init`、`postgres`、`moemail`，完整配置为 12 个服务。默认 Web 使用 standalone `latest`，维护服务使用按需 `latest-tools`；PostgreSQL 另有 server/tools 两个 package。新镜像已在 GitHub 原生 Linux runner 完成逐镜像 pull/run smoke，但本机仍没有 Docker daemon，因此尚未按两份 Compose 实跑 bind mount 权限、backup/restore、IMAP 容器出站连通与 migration 失败阻断；上面的 VPS 结果来自改造前一版 Compose，不能替代目标机验收。
- rclone 到真实异机/对象存储后的 checksum、immutable 与独立恢复演练。

这些属于生产环境验收，不是剩余源码实现；部署时按 `docs/local-deployment.zh-CN.md` 的上线清单逐项打勾。
