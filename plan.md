# MoeMail 主要本地部署改造计划（SQLite + PostgreSQL）

## 1. 目标

将 MoeMail 改造成以下部署形态：

```text
Browser
  -> HTTPS reverse proxy
  -> Local Next.js production server
  -> SQLite（单实例默认）或 PostgreSQL（多实例/高并发）

首次启动 WebUI / 皇帝运行配置面板 / 运维直接编辑
  -> data/config.yaml
  -> schema + 数据库探测/migration
  -> 校验成功后热加载；失败保留 last-known-good

Cloudflare Email Routing
  -> Cloudflare Email Worker
  -> 直连 HTTPS POST，或 R2 + Queue 耐久缓冲
  -> /api/internal/email
  -> 本地数据库

systemd 常驻 scheduler
  -> 按已验证 YAML 动态执行 cleanup/backup/monitor/offsite
  -> 本地数据库与备份目标

Docker Compose scheduler/monitor/offsite profiles
  -> cleanup + backup + health/容量检查 + rclone 异地同步
```

主要目标：

- Next.js Web 和 API 使用标准 Node.js production 运行，不依赖 Cloudflare Pages。
- 使用本地 SQLite 或 PostgreSQL 替代 D1，尽量保留业务查询。
- 使用数据库配置表替代 Cloudflare KV。
- 本地应用不使用 `.env` 或部署环境变量；首次启动由 WebUI 选择数据库并生成 `data/config.yaml`，后续支持 WebUI/YAML 双向修改和失败回退。
- Email Worker 仅保留邮件接收和 HTTPS 转发能力。
- 使用读取已验证 YAML 的服务器常驻 scheduler 替代 Cleanup Worker。
- 将平台差异集中在少量适配层，降低以后合并官方更新的成本。

源码范围仍不包含：

- 附件存储和附件 UI。
- PostgreSQL 集群编排、自动故障切换等数据库 HA 平台能力。
- WebSocket/SSE 实时推送。
- 大规模业务重构或 UI 改版。

## 1.1 当前实施状态

| 能力 | 状态 | 主要入口 |
|---|---|---|
| Node.js production Web/API | 已完成 | `app/lib/db.ts`、`middleware.ts`、`app/api/**` |
| SQLite schema/migration/导入 | 已完成 | `drizzle-local/`、`scripts/sqlite/` |
| PostgreSQL schema/migration/导入 | 已完成 | `drizzle-postgres/`、`scripts/postgres/` |
| DB 配置表替代 KV | 已完成 | `app/lib/config-store.ts` |
| 首次 WebUI 初始化与 YAML 运行配置 | 已完成；SQLite/PG production HTTP 已验收 | `app/components/setup/`、`app/lib/config/`、`app/api/setup/`、`app/api/runtime-config/` |
| Email Worker 直连转发 | 源码/配置完成；实网待验收 | `workers/email-receiver.ts` |
| R2 + Queue 耐久转发 | 源码/配置完成；实网待验收 | `wrangler.email.durable.example.json` |
| D1 Worker 回退资产 | 已保留 | `workers/email-receiver-d1.legacy.ts` |
| systemd 动态 maintenance scheduler | 源码/本机 LKG 验证完成；Linux unit 待验收 | `scripts/ops/runtime-scheduler.ts`、`deploy/local/` |
| Docker Compose 单文件部署 | 单个 `compose.yaml`、同目录 bind mounts、无内置 Caddy、无 env/build；官方 Compose v5.4.0 默认/全 profiles `config` 通过，实际 `docker compose up -d` 待目标 Docker 主机验收 | `compose.yaml`、`.github/workflows/publish-docker.yml` |
| 定时备份、监控、异地同步 | 源码/配置完成；目标环境待验收 | `scripts/ops/`、Compose profiles、systemd units |
| 唯一站主安全初始化 | 首次 WebUI 创建；数据库缺失站主时回到 token 保护的恢复向导 | `app/lib/setup-service.ts`、`app/lib/emperor.ts` |
| Credentials 密码、运行时 secret 与防滥用 | 已完成 | `app/lib/password.ts`、`app/lib/auth-abuse-guard.ts`、`scripts/validate-config.ts` |
| PWA/API 数据隔离 | 已完成 | `next.config.ts`、`public/pwa-cache-cleanup.js` |
| 外部 OAuth/MX/Resend/Turnstile、Linux 裸机/PostgreSQL Compose/rclone 验收 | 待部署时执行 | 需要目标主机、真实域名和第三方凭据 |

## 2. 已验证的技术结论

- `package.json` 已有 `next build` 和 `next start`，Next.js 本身可以本地 production 运行。
- Web 数据库入口集中在 `app/lib/db.ts`，绝大多数 Drizzle 查询可以保留。
- `app/lib/schema.ts` 是动态 facade，底层分别使用 `schema.sqlite.ts` 与 `schema.postgres.ts`。
- Web/API 已切换 Node Runtime，middleware 不再导入数据库或信任 `X-User-Id`。
- SQLite 与 PostgreSQL 共用 `createDb()`、schema facade 和大多数业务查询。
- `data/config.yaml` 是本地应用唯一运行配置源；WebUI 与直接文件修改共用 strict schema、数据库/唯一站主预检、原子写入、fingerprint CAS/跨进程保存锁和 `.lkg` 回退。冷启动不会直接信任同内容 LKG，仍会重验数据库中恰有一个站主。
- KV 的 10 个字符串配置键已迁移到 `site_config`，API/UI 契约保持不变。
- Email Worker 只负责接收、缓冲和转发；MIME 解析、幂等入库和 Webhook 在本地 API 执行。
- Cleanup 已按数据库后端分批清理；SQLite 使用跨容器文件锁，PostgreSQL 使用 advisory lock。
- 当前 `drizzle/0000` 到 `0018` 不能从空库完整重放：`0013` 会读取此前未创建的 `to_address`、`type` 和 `sent_at` 字段。
- 消息列表已不返回正文，默认轮询为 25 秒，轮询不再执行全量 `count(*)`。
- 两套数据库都用 `UNIQUE LOWER(address)` 防止大小写变体邮箱错投；创建冲突返回 409，D1 导入会拒绝冲突源数据。
- 首次 WebUI 由落盘的一次性 setup token 与跨进程 setup operation lock 保护，并在 SQLite/PG 分别使用排他事务/advisory lock 创建唯一皇帝；成功后 token 删除，禁止“公网首个注册用户抢占”。
- Credentials 新密码使用版本化 scrypt 与随机 salt，旧 SHA-256 哈希在成功登录后惰性升级；配置 schema 校验所有 secret、限流和并发参数，注册/登录另有进程级全局/客户端限流与 scrypt 并发闸门。
- PWA 只预缓存静态构建资源，动态页面/API 使用网络且响应 `private, no-store`；升级时主动清除旧运行时缓存。

## 3. 技术决策

### 3.1 默认数据库

默认使用本地 SQLite：

- 单个 Next.js 实例。
- 数据库文件位于本地持久化 SSD/NVMe。
- 开启 WAL、foreign keys 和 busy timeout。
- 不使用 NFS、SMB 或多容器共享 SQLite 文件。

满足以下任一条件时使用已实现的 PostgreSQL 路线：

- 需要多个 Next.js 实例。
- 活跃收件箱长期超过 300 至 500 个。
- 持续收信超过约 100 封/分钟。
- 出现持续的 SQLite 写锁等待。
- 需要连接外部托管/集群化 PostgreSQL，以获得数据库高可用和在线故障切换；仓库内 Compose 本身仍是单节点。

PostgreSQL 使用独立 `pg-core` schema、migration、D1 导入和 cleanup；业务代码仍通过动态 schema facade 与 `createDb()` 调用。

### 3.2 Next.js Runtime

默认采用 Node Runtime；按 `data/config.yaml` 的 `database.driver` 选择原生 SQLite driver 或 PostgreSQL pool。

当前采用拆分后的 Node 鉴权结构：

- middleware 只保留语言跳转和 Edge-safe 逻辑。
- API Key 查询移入 Node Route Handler/helper。
- 角色权限校验移入受保护的 Route Handler。
- 不再信任客户端提供的 `X-User-Id`。

### 3.3 配置存储

运行配置与业务配置分层：

- `data/config.yaml` 保存数据库、站点地址、鉴权/OAuth、投递 secret、cleanup/scheduler/monitor/offsite 等本地进程配置。
- 首次启动 WebUI 通过两阶段提交完成数据库探测、migration、皇帝创建与随机 secret 生成；崩溃重试复用已落盘 pepper，初始化后皇帝可在运行配置面板修改完整 YAML。
- 文件监视器对直接编辑执行 schema、数据库连接与 migration 校验；成功才提交并更新 `config.yaml.lkg`，失败继续使用旧配置。
- 同一数据库类型的连接参数可准备后热切换；数据库 driver 改变由守护进程重启后生效。
- Compose 和 systemd 不注入应用 `environment`/`env_file`/`EnvironmentFile`；两者的常驻 scheduler 都从已验证 LKG 动态读取周期。

业务设置继续使用所选数据库中的 `site_config` 表：

在所选数据库中增加 `site_config` 表：

- `key`: primary key。
- `value`: text。
- `updated_at`: timestamp。

新增集中式 `ConfigStore`，保留现有配置键和 API JSON 契约。

### 3.4 邮件转发

推荐 Worker 转发原始 RFC822 邮件和 SMTP envelope：

- 使用 `message.to` 和 `message.from`，不使用可伪造的 MIME `To` 作为投递目标。
- Worker 使用独立的 `EMAIL_INGEST_SECRET` 调用本地 API。
- 本地 API 负责 MIME 解析、邮箱查找、幂等入库和后续 Webhook。
- 对重复投递返回成功，但不得重复插入或重复触发 Webhook。

当前统一转发原始 RFC822，以保留稳定摘要、可靠 MIME 解析和未来扩展空间；本地仍只保存 subject/text/html，不保存附件。

### 3.5 清理任务

新增本地 cleanup 命令，由常驻 scheduler 按已验证 YAML 的动态周期调用：

- 分批查找过期邮箱 ID。
- 先按真实行数上限显式删除消息分享、消息和邮箱分享，再删除已无从属数据的邮箱；外键级联只作兜底。
- 循环处理直至无记录或达到单次运行上限。
- SQLite 使用跨容器原子文件锁，PostgreSQL 使用 advisory lock，避免任务重叠。

## 4. 实施阶段

### 阶段 0：建立基线

已记录：

- 本地化起点 commit：`6c19aefc71ca60bc194a6003c13bae1e2960363b`。
- 工作分支：`feat/local-deployment`。
- `origin`：`https://github.com/XMZO/moemail-local.git`。
- `upstream`：`https://github.com/beilunyang/moemail.git`，禁止 push。
- 原 D1 Email Worker 另存为 `workers/email-receiver-d1.legacy.ts`。

需要复现原 Cloudflare 版本时，不覆盖当前工作树，使用独立 worktree：

```bash
git worktree add ../moemail-cloudflare-baseline 6c19aefc71ca60bc194a6003c13bae1e2960363b
```

任务：

- 为本地化工作建立独立分支。
- 记录当前上游基线 commit。
- 保留 `origin` 为 `XMZO/moemail-local`，保留只读 `upstream` 为官方仓库。
- 建立最小回归清单：登录、注册、创建邮箱、收信、查看、删除、分享、角色、API Key、配置和发件。
- 准备独立临时目录中的测试 YAML，验证 secret 不进入仓库或命令行历史。

验收：

- 上游基线 commit、远程仓库、legacy Worker 和独立 worktree 复现命令均已记录。
- 本地实现的可重复验证记录位于 `docs/local-validation.zh-CN.md`；依赖真实 Cloudflare 账号的原链路行为在部署验收中执行，不伪造结果。
- 工作分支可以随时对照或回退到上游基线。

### 阶段 1：本地 Node production 骨架

预计核心文件：

- `package.json`
- `next.config.ts`
- `middleware.ts`
- `app/api/**/route.ts`
- `app/[locale]/layout.tsx`
- `app/[locale]/page.tsx`
- `app/[locale]/login/page.tsx`
- `app/[locale]/moe/page.tsx`
- `app/[locale]/profile/page.tsx`

任务：

- 确定 Next.js 版本和 Node middleware 路线。
- 去除 Web production 对 `setupDevPlatform` 的依赖。
- 将需要数据库的 Route/Page 改为 Node Runtime。
- 保持 PWA、next-intl、图片和前端相对 API URL 不变。
- 验证反向代理后的 Host、HTTPS、Cookie 和 OAuth callback。

验收：

- `next build` 成功。
- `next start` 可在无 Cloudflare Pages runtime 的环境启动。
- 未配置 D1/KV binding 时不再因 `getRequestContext()` 失败。

回退：

- 保留原 Cloudflare deployment 文件，不在本阶段删除。

### 阶段 2：D1 替换为本地 SQLite

预计核心文件：

- `app/lib/db.ts`
- `app/lib/schema.sqlite.ts`
- `drizzle.local.config.ts`
- `scripts/sqlite/migrate.ts`
- `scripts/generate-test-data.ts`
- `types.d.ts`
- `package.json`
- 新的本地 migration 目录

任务：

- 引入选定的 Node SQLite driver。
- 在 `app/lib/db.ts` 建立进程级单例连接。
- 启动连接时设置：
  - `PRAGMA journal_mode = WAL`
  - `PRAGMA foreign_keys = ON`
  - `PRAGMA busy_timeout = 5000`
  - `PRAGMA synchronous = NORMAL`
- 保持 `createDb()` API 和现有 schema export 名称。
- 基于当前 `app/lib/schema.sqlite.ts` 生成一份独立的本地 baseline。
- 不直接重放现有 `0000` 至 `0018` 历史迁移。
- 定义本地 migration tracking 和启动流程。

验收：

- 全新空目录可以创建数据库并完成初始化。
- 现有 Drizzle relations、Auth.js adapter、分页和 `returning()` 正常。
- 删除用户、邮箱时外键级联正常。
- 并发收信和 Web 操作不会频繁出现 `database is locked`。

### 阶段 2B：PostgreSQL 兼容路线

预计核心文件：

- `app/lib/schema.postgres.ts`
- `app/lib/local-schema.postgres.ts`
- `app/lib/database-dialect.ts`
- `drizzle.postgres.config.ts`
- `drizzle-postgres/`
- `scripts/postgres/`

任务：

- 保留相同 table/schema export 名称与 `createDb()` API。
- 将 SQLite 时间整数与布尔值映射为 PostgreSQL `timestamptz` 与 boolean。
- 提供独立 migration、verify、D1 import、cleanup、backup 和 restore。
- 使用 pool singleton、连接上限和 advisory lock。
- 对 D1 秒/毫秒时间字段执行显式转换，并校验逐表 hash 与正文 hash。

验收：

- 空 PostgreSQL 数据库可迁移、重复迁移和校验。
- Auth adapter、relations、ConfigStore、幂等插入、显式关联行删除和 cleanup 正常。
- SQLite 与 PostgreSQL 可使用同一套 Web/API handler。

### 阶段 3：KV 替换为配置表

预计核心文件：

- `app/lib/schema.ts`
- 新增 `app/lib/config-store.ts`
- `app/api/config/route.ts`
- `app/api/config/email-service/route.ts`
- `app/api/emails/generate/route.ts`
- `app/api/emails/[id]/send/route.ts`
- `app/lib/auth.ts`
- `app/lib/send-permissions.ts`
- `app/lib/turnstile.ts`

需要保留的配置键：

- `DEFAULT_ROLE`
- `EMAIL_DOMAINS`
- `ADMIN_CONTACT`
- `MAX_EMAILS`
- `TURNSTILE_ENABLED`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `EMAIL_SERVICE_ENABLED`
- `RESEND_API_KEY`
- `EMAIL_ROLE_LIMITS`

任务：

- 提供字符串 `get/put` 或类型化配置接口。
- 多键更新使用事务或批量 upsert。
- 保持现有 API 返回格式和配置 UI 不变。
- 明确敏感配置的文件权限和备份策略。

验收：

- 网站配置、Turnstile、默认角色、邮箱域名和 Resend 配置可读写。
- 重启 Next.js 后配置仍然存在。

### 阶段 4：Email Worker 改为 HTTPS 转发

预计核心文件：

- `workers/email-receiver.ts` 或新增 `workers/email-forwarder.ts`
- `wrangler.email.example.json`
- 新增 `app/api/internal/email/route.ts`
- `middleware.ts`
- `types.d.ts` 或 Worker 专用 Env 类型
- `app/lib/webhook.ts`
- 可选的 schema/migration 幂等字段

任务：

- 去除 Email Worker 的 D1 binding。
- 配置本地 ingestion URL，secret 通过 Wrangler secret 注入。
- 新内部 API 只接受经过服务认证的请求。
- 设置请求体大小、读取超时和 MIME 解析失败处理。
- 生成稳定的 ingest key：优先使用 envelope recipient 与原始邮件摘要。
- 插入消息时保证幂等。
- 数据成功落盘后再返回成功响应。
- 明确用户 Webhook 在本地执行还是由 Worker 执行。
- 如果由本地执行，增加 SSRF 防护和重定向复核。
- 移除完整邮件内容日志。

验收：

- 正常邮件可以从 Cloudflare 到达所选本地数据库。
- 未知收件地址、无效 secret、超大邮件和解析失败有明确状态码。
- 同一邮件重复投递不会产生重复消息。
- 直连模式在本地不可用时明确失败；耐久模式先写 R2，再由 Queue 重试，定时任务补投孤儿对象。
- 达到最大重试次数的对象移入 R2 `failed/` 前缀并记录错误，等待人工检查或重放。

回退：

- 保留 `email-receiver-d1.legacy.ts` 与对应 Wrangler 模板，切换 Email Routing target 即可恢复旧链路。

### 阶段 5：Cleanup Worker 替换为本地 scheduler

预计核心文件：

- 新增 `scripts/cleanup.ts`
- `package.json`
- 本地部署文档
- systemd 常驻 scheduler unit

任务：

- 复用本地 DB factory 和 schema。
- 使用可跨 SQLite/PostgreSQL 的分批删除方式，不依赖 `DELETE ... LIMIT`。
- 单次任务循环清理积压，而不是固定只删除 100 条。
- 增加互斥锁、退出码和结构化日志。

验收：

- 过期邮箱、消息和分享记录被正确删除。
- 永久邮箱不受影响。
- 两个 cleanup 进程不会同时执行。

### 阶段 6：生产部署配置

预计新增或修改：

- `app/lib/config/` 与首次启动 WebUI
- `README.zh-CN.md`
- `Dockerfile` 与 SQLite/PostgreSQL Compose
- systemd Web/scheduler services
- Caddy/Nginx 示例配置
- 备份和恢复脚本/文档

本地配置要求：

- 首次启动只暴露由一次性 token 保护的 WebUI，在页面配置公网 URL、可信代理、SQLite/PostgreSQL、唯一皇帝和可选 OAuth。
- 初始化先探测/迁移并检查目标库，再以可恢复的两阶段提交生成 `data/config.yaml`：先持久化 `setup=false` 与固定 secret/pepper，再创建站主并原子切换 `setup=true`；配置文件权限为 `0600`。
- WebUI 保存和直接编辑 YAML 都必须先校验；数据库相关变化还要先探测并运行 migration，失败不得改变当前运行状态。
- Docker Compose 不含 `environment`/`env_file`；systemd 不含 `EnvironmentFile`；维护脚本与 sidecar 读取同一份已验证 YAML/LKG。
- SQLite 数据库与备份路径限制在共享的 `data/` 持久卷；每个异地数据库备份都配对上传同名前缀的已验证 `config.yaml.lkg`，支持全新卷恢复。
- Worker 侧仍单独配置 ingestion URL，并通过 Wrangler Secret 保存与 YAML 一致的 `EMAIL_INGEST_SECRET`。

生产要求：

- 数据库位于持久化本地 SSD/NVMe。
- SQLite 路线只运行单个 Next.js 写实例；PostgreSQL 可按连接池预算扩展。
- HTTPS 证书有效，反向代理正确传递 Host/Proto。
- ingestion 路由的 body limit 覆盖允许的邮件大小。
- 每日异地备份，定期进行恢复演练。
- 监控磁盘、WAL、HTTP 5xx、ingestion 非 2xx 和 cleanup 退出码。

验收：

- 服务器重启后 Web、cron 和数据库自动恢复。
- 数据库备份可以在独立目录恢复并启动应用。

### 阶段 7：存量 D1 数据迁移和切换

如果没有需要保留的 D1 数据，可跳过数据导入，只使用本地 baseline。

有存量数据时：

1. 进入维护窗口，停止新建邮箱和配置写入。
2. 导出 D1 schema、数据和 KV 配置。
3. 在本地创建当前版本 schema，不运行旧 D1 migration 链。
4. 仅导入业务数据，并校验秒/毫秒时间字段。
5. 导入 KV 配置到 `site_config`。
6. 比较每张表行数、关键外键和样本邮件正文。
7. 部署本地 Web/API。
8. 切换 Email Worker ingestion URL。
9. 观察一段时间后停止 Cleanup Worker。
10. 保留 D1 只读备份，达到保留期后再决定删除。

切换验收：

- 登录和已有用户角色正常。
- 已有邮箱、邮件、分享、Webhook 和 API Key 可用。
- 新邮件只写入本地数据库。
- 未出现重复邮件或持续 ingestion 错误。

## 5. 性能与容量基线

推荐起步服务器：

- 2 vCPU
- 4 GB RAM
- 50 GB NVMe
- 1 至 2 GB swap

保守目标：

- 50 至 150 个正在查看收件箱的活跃页面。
- 5 万以内邮箱地址行。
- 10 至 30 封/分钟持续收信。
- 根据平均邮件正文大小存储约 30 万封邮件。

扩容前优先优化：

- 消息列表接口不返回 `content/html`，正文只由详情接口读取。
- 默认 25 秒轮询，并允许通过 WebUI 或 `server.emailPollIntervalMs` 热调整。
- 避免每次轮询重复执行多次 Auth.js session、角色和 account 查询。
- 避免每次轮询执行全量 `count(*)`。
- 为永久邮箱增加独立消息保留策略。

## 6. 测试清单

### 功能

- 用户名密码注册和登录。
- GitHub/Google OAuth。
- 一次性 token 首次初始化、唯一 emperor 创建和角色升降级。
- WebUI 与直接编辑 YAML 的成功应用、并发 fingerprint/保存锁冲突、无效候选回退和数据库 driver 重启。
- 创建、列出和删除邮箱。
- 收取、查看和删除邮件。
- 邮箱和单封邮件分享。
- API Key 创建、禁用和调用。
- Webhook 保存、测试和实际通知。
- Resend 发件和每日限额。
- Turnstile 开启和关闭。
- cleanup 显式分批删除各关联表，单次真实删除总行数不超过配置上限。

### 安全

- 客户端伪造 `X-User-Id` 无效。
- setup token 错误时拒绝；并发首次初始化只能成功一人，完成后 setup 接口关闭且 token 文件删除。
- 大小写不同的同一邮箱地址不能被两个用户分别创建。
- ingestion secret 错误时拒绝请求。
- 重放同一 ingestion 请求不重复入库。
- 用户 Webhook 不能访问 loopback、private、link-local 和元数据地址。
- 配置 API 不向无权限用户返回 secret。
- 注册/登录不返回密码哈希，新密码使用慢 KDF，旧哈希可安全惰性升级。
- 注册与 Credentials 登录在 Turnstile 关闭时仍有全局/客户端限流，scrypt 超载快速失败；多实例由可信代理提供共享限流。
- API、RSC 和账号页面不会被 Service Worker 跨会话缓存。
- OAuth callback、Cookie Secure/SameSite 和代理 Host 正确。

### 可靠性

- Next.js 重启期间 Worker 转发行为明确。
- SQLite WAL 恢复正常。
- 磁盘空间不足有告警。
- cleanup 重入被阻止。
- 数据库备份可恢复。
- 大邮件、无正文邮件、HTML-only 邮件和无主题邮件正常处理。

### 性能

- 50、100、200 个活跃轮询客户端阶梯压测。
- 典型小邮件和大 HTML 邮件分别测试。
- 记录 API p50/p95/p99、CPU、RSS、SQLite busy、响应大小和出口带宽。
- 并发 ingestion 与 Web 轮询同时测试。

## 7. 上游更新策略

远程仓库约定：

- `origin`: `https://github.com/XMZO/moemail-local.git`
- `upstream`: `https://github.com/beilunyang/moemail.git`

建议保持以下提交边界：

1. Node runtime 和 middleware。
2. SQLite DB adapter 和本地 baseline。
3. PostgreSQL schema、adapter 和 migration。
4. ConfigStore 与 YAML runtime config/首次启动向导。
5. Email ingestion 与 durable Worker。
6. Cleanup、Docker 和运维配置。

同步流程：

```bash
git fetch upstream
git switch feat/local-deployment
git rebase upstream/master
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm build
```

每次同步后检查：

```bash
rg '@cloudflare/next-on-pages|getRequestContext|drizzle-orm/d1|runtime.*edge' app next.config.ts middleware.ts
rg 'SITE_CONFIG|env\.DB' app next.config.ts middleware.ts
```

重点人工审查：

- 上游新增的 schema 和 migration。
- 新增 API Route 是否声明 Edge Runtime。
- 新增 D1/KV 直接调用。
- Email Worker 对 MIME、附件或消息字段的变化。
- middleware、Auth.js 和 API Key 鉴权变化。
- Cleanup Worker 的过期语义变化。

不要修改或删除上游历史 migration。SQLite 本地 migration 使用独立目录，按语义同步上游 schema 变更。

## 8. 预计工作量

| 工作项 | AI 实施估算 |
|---|---:|
| Node production、鉴权与 SQLite | 0.8 至 1.5 AI 日 |
| PostgreSQL schema、迁移与导入 | 0.8 至 1.5 AI 日 |
| Email 直连与 R2/Queue 耐久模式 | 0.5 至 1 AI 日 |
| Docker/Compose、systemd 与运维 | 0.5 至 1 AI 日 |
| 双后端回归、压测和文档 | 0.8 至 1.5 AI 日 |

从干净上游重新实施，预计 3 至 5 AI 日可达到当前源码状态；含真实域名、OAuth、Cloudflare、Resend、对象存储和目标 Linux 恢复演练，建议预留 5 至 8 AI 日及相应人工账号操作时间。

## 9. 完成标准

- Web/API 不依赖 Cloudflare Pages、D1 或 KV 即可运行。
- 直连模式在 Cloudflare 仅保留 Email Routing 和 Email Worker；选择耐久模式时额外使用 R2、Queue 与 DLQ。
- 所有新邮件经过认证的 HTTPS 接口进入本地数据库。
- 重复投递不会产生重复邮件。
- cleanup 完全由服务器计划任务执行。
- SQLite 可备份、可恢复、可从空环境初始化。
- PostgreSQL 可迁移、校验、备份、恢复并从 D1 导入。
- SQLite 与 PostgreSQL Compose 均提供健康检查、定时 cleanup/backup、监控与异地同步 profile。
- 全新启动可完全在 WebUI 选择数据库、创建皇帝并生成 `data/config.yaml`；本地应用无需 `.env` 或应用环境变量。
- 皇帝可在 WebUI 修改完整运行配置，直接编辑 YAML 也能热加载；无效候选不应用，last-known-good 可在重启时恢复。
- 消息列表不携带正文，轮询间隔与永久邮箱消息保留策略可配置。
- 邮箱地址大小写唯一与唯一站主约束均由数据库/事务保证并被 verify/import 检查。
- 过期邮箱不再收信，邮箱地址限安全 ASCII 并跨数据库统一规范化。
- production secret、Credentials scrypt/限流与 PWA/API no-store 数据隔离均有启动/运行时保护。
- 核心功能回归通过。
- 有明确的上游合并流程和平台依赖扫描命令。
- Cloudflare 原部署资产被保留，可在切换失败时回退。
