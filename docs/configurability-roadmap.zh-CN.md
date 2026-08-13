# MoeMail 可配置化候选审计

> 状态：调研文档，不代表功能已经实现
> 审计日期：2026-08-12

## 1. 目的

本文记录当前源码中由常量、固定选项或框架默认值控制，但适合逐步开放给站点管理员或普通用户配置的功能。

这里将配置分成三类：

- **站点业务策略**：保存在数据库 `site_config`，由皇帝账号在 WebUI 中管理。
- **用户偏好**：按用户保存，不影响其他账号。
- **实例运行参数**：保存在 `data/config.yaml`，由运行配置页面管理并接受严格校验。

安全边界、协议硬上限和数据完整性约束不应为了“灵活”而开放配置。

## 2. 当前已经支持的配置

以下内容已经可配置，不需要重复实现：

- SQLite/PostgreSQL、连接池、连接超时和 TLS。
- 数据库备份、保留期、清理、调度、监控和 rclone 异地备份。
- GitHub/Google 登录、Turnstile、登录与注册限流。
- 收件域名及每个域名的 Worker、IMAP 或禁用策略。
- IMAP 轮询间隔、每轮最大邮件数。
- Resend、SMTP 或禁止发件；SMTP 支持 `AUTO`、`PLAIN`、`LOGIN`。
- 默认角色、角色权限、用户权限覆盖。
- 活跃邮箱数、邮箱最长有效期、每日收发量、单封邮件大小等额度。
- 管理员联系方式和站点字体。

## 3. 推荐优先级

| 优先级 | 功能 | 配置主体 | 推荐存储位置 |
| --- | --- | --- | --- |
| P0 | 注册策略 | 管理员 | `site_config` |
| P0 | 邮件远程内容与默认阅读模式 | 管理员默认值 + 用户覆盖 | `site_config` + 用户偏好 |
| P1 | 邮箱有效期预设和默认值 | 管理员 | `site_config` |
| P1 | 分享链接策略 | 管理员 | `site_config` |
| P1 | API Key 生命周期和数量策略 | 管理员 + 用户选择 | `site_config` |
| P1 | 登录会话有效期 | 管理员 | `config.yaml` |
| P2 | 站点品牌与外观 | 管理员 | `site_config` |
| P2 | IMAP 全局并发与超时 | 管理员 | `config.yaml` |
| P2 | Webhook 投递策略 | 管理员 | `config.yaml` |
| P2 | 默认语言及启用语言 | 管理员 + 用户选择 | `site_config` + 用户偏好 |
| P3 | 列表密度、分页大小等界面偏好 | 用户 | 用户偏好 |
| 独立功能 | 通用 OIDC/Entra ID 网页登录 | 管理员 | `config.yaml` |
| 独立功能 | IMAP/SMTP OAuth2 | 管理员按域名配置 | 域名策略 + 加密凭据存储 |

## 4. 详细候选

### 4.1 注册策略

当前行为：

- 初始化完成后，`POST /api/auth/register` 始终接受注册请求。
- 登录页面始终显示“注册”页签。
- Turnstile 和请求限流只能降低滥用风险，不能关闭注册。

源码位置：

- `app/api/auth/register/route.ts`
- `app/components/auth/login-form.tsx`

建议配置：

```yaml
registration:
  mode: closed # closed | open | invite
  maxUsers: 0  # 0 表示不限
```

更推荐先把它作为数据库业务配置，而不是 YAML。这样管理员可以即时修改，登录页也能读取公开的安全子集来隐藏注册入口。

注意事项：

- 服务端必须执行策略，不能只隐藏注册按钮。
- 邀请码应存哈希、支持过期和使用次数限制。
- 首次初始化创建皇帝账号不受注册关闭影响。

### 4.2 邮件远程内容与阅读模式

当前行为：

- 有 HTML 内容时默认显示 HTML。
- 普通邮件和公开分享页都会在 iframe 内写入邮件 HTML。
- 脚本被 sandbox 限制，但远程图片仍可能加载，发送方可通过追踪像素获知查看时间和访问 IP。

源码位置：

- `app/components/emails/message-view.tsx`
- `app/components/emails/shared-message-detail.tsx`

建议配置：

- 管理员默认策略：`block`、`ask`、`allow`。
- 用户可以覆盖自己的默认策略。
- 用户可以选择默认显示 HTML 或纯文本。
- 每封邮件提供一次性的“加载外部图片”按钮。
- 匿名分享页建议默认强制阻止远程内容。

这应当是最高优先级的隐私改进之一。

### 4.3 邮箱有效期预设

当前行为：有效期写死为 1 小时、24 小时、3 天、永久，并默认选择 24 小时。

源码位置：

- `app/types/email.ts`
- `app/components/emails/create-dialog.tsx`
- `app/api/emails/generate/route.ts`

建议配置：

```json
{
  "allowedMailboxLifetimes": [3600, 86400, 259200, 604800, 0],
  "defaultMailboxLifetime": 86400,
  "allowPermanentMailbox": true
}
```

单位应统一为秒或毫秒，接口、WebUI 和文档必须使用同一个定义。现有角色额度中的 `maxMailboxLifetimeDays` 继续作为最终上限，不能被预设绕过。

### 4.4 分享链接策略

当前行为：

- 分享界面复用固定的邮箱有效期选项。
- 服务端接收任意 `expiresIn`，没有严格白名单或边界验证。
- 可以创建永久分享。

源码位置：

- `app/components/emails/share-dialog.tsx`
- `app/components/emails/share-message-dialog.tsx`
- `app/api/emails/[id]/share/route.ts`
- `app/api/emails/[id]/messages/[messageId]/share/route.ts`

建议配置：

- 允许的分享有效期列表及默认值。
- 是否允许永久分享。
- 每个邮箱、每封邮件的最大活动分享数。
- 是否默认关闭全邮箱分享，只允许单封邮件分享。

实现前必须先补服务端 schema 校验，不能信任客户端传入的毫秒数。

### 4.5 API Key 策略

当前行为：

- 每个新 API Key 固定一年后过期。
- 没有管理员定义的默认期限、最大期限或每用户数量限制。
- API Key 目前以明文保存在数据库中，并通过明文相等查询认证。

源码位置：

- `app/api/api-keys/route.ts`
- `app/lib/apiKey.ts`
- `app/lib/schema.sqlite.ts`
- `app/lib/schema.postgres.ts`

建议配置：

- 管理员设置默认期限、最大期限和每用户数量上限。
- 用户创建时从管理员允许的期限中选择。
- 后续可增加用途范围，例如只读邮箱、收件、发件、管理分享。

在扩充配置前，应优先把 Key 改为只展示一次、数据库只保存哈希。哈希存储属于安全修复，不应做成可选项。

### 4.6 登录会话有效期

当前只指定 Auth.js 使用 JWT session，没有在项目内显式声明会话期限，因此实际行为依赖框架默认值。

源码位置：`app/lib/auth.ts`

建议增加：

- 会话最大有效期。
- 可选的会话刷新周期。
- 管理员执行“让全部会话失效”的显式操作。

需要设置安全的最小值和最大值，避免误填导致永久会话或所有用户持续掉线。

### 4.7 站点品牌与外观

当前 `MoeMail` 名称、PWA 名称、页面元数据和部分页脚内容写死；字体已经支持配置。

源码位置示例：

- `public/manifest.json`
- `app/[locale]/layout.tsx`
- `app/components/float-menu.tsx`
- `app/i18n/messages/*`

建议配置：

- 站点名称、短名称和简介。
- Logo、favicon、PWA 图标。
- 主题主色。
- 页脚文字。
- 是否显示源码链接及其目标地址。

上传的品牌资源应保存为本地受控文件，限制 MIME、尺寸和文件大小；不要允许任意 HTML 或脚本。

### 4.8 IMAP 全局资源控制

当前每个域名的轮询间隔和每轮邮件数已经可配置，但整个进程仍有固定值：

- 调度 tick：5 秒。
- 同时处理账号数：4。
- 账号租约：5 分钟。

源码位置：`app/lib/imap-inbound.ts`

建议只开放有明确运维价值的参数：

- 全局最大并发账号数。
- 连接、认证和读取超时。

调度 tick、租约内部算法宜继续由程序推导，避免管理员制造重复收取或抢锁问题。

### 4.9 Webhook 投递策略

当前固定为重试 3 次、超时 10 秒、重试间隔 1 秒，并且只有 `new_message` 事件。

源码位置：

- `app/config/webhook.ts`
- `app/lib/webhook.ts`

建议增加实例级配置：

- 全局启用/禁用。
- 超时、最大重试次数和退避策略。
- 每个用户可订阅的事件类型。

Webhook 地址的 SSRF 防护、私有地址限制和协议限制必须继续作为不可关闭的安全边界。

### 4.10 语言和界面偏好

当前支持语言集合以及默认英文写死在 `app/i18n/config.ts`。

建议：

- 管理员从已经编译进应用的语言中选择站点默认语言。
- 管理员可隐藏不需要的语言。
- 用户偏好继续覆盖站点默认值。
- 邮件列表每页条数、默认阅读模式等保存为用户偏好。

不能允许管理员填入任意 locale 名称，因为没有对应翻译包时无法正常渲染。

## 5. Microsoft 相关功能需要分开设计

“Microsoft 鉴权”至少包含两套完全不同的功能：

### 5.1 网页账号登录

当前 Auth.js 只配置 GitHub 和 Google。可以增加：

- Microsoft Entra ID provider；或者
- 通用 OIDC provider，兼容 Entra ID、Authentik、Keycloak 等。

这是用户登录 MoeMail WebUI 的身份认证。

### 5.2 邮件服务器认证

当前 IMAP/SMTP 只有用户名和密码认证，SMTP 的 `LOGIN` 只是传统密码认证，并不等于 Microsoft OAuth2。

若要兼容关闭 Basic Auth 的 Outlook/Microsoft 365，需要实现：

- IMAP `XOAUTH2`/OAuth2。
- SMTP OAuth2。
- tenant、client id、refresh token 或设备授权流程。
- Token 刷新、轮换和加密存储。

这是独立的新功能，不能通过把现有 `authMethod` 多加一个字符串就可靠完成。

## 6. 应直接修复，而不是做成配置

以下项目属于正确性或安全问题：

1. 分享接口必须严格校验 `expiresIn` 类型、范围和允许值。
2. 过期分享记录应按分享自身的 `expires_at` 清理，而不是只等待父邮箱过期。
3. API Key 应哈希保存，不能提供“是否加密”的管理员开关。
4. 文档、WebUI 和服务端必须共用同一组邮箱/分享有效期定义。
5. HTML 邮件远程内容在引入用户配置前，应先确定一个安全的默认策略。

## 7. 不建议开放的内部参数

以下内容应继续由源码和严格 schema 控制：

- API Key、分享 Token、初始化 Token 的随机长度和熵。
- 密码哈希算法及最低强度。
- SSRF、私网地址、重定向和协议限制。
- 数据库校验、迁移和唯一站主约束。
- 配置原子写入、跨进程锁和 LKG 回退逻辑。
- 邮件原始大小的系统硬上限；管理员只能设置更低的业务额度。
- PostgreSQL HBA 和内部网络隔离安全边界。
- Worker 与本地 ingest 之间的鉴权方式。

## 8. 推荐实施顺序

### 第一阶段：安全和隐私

1. 注册开关及服务端门禁。
2. 分享接口校验和过期记录清理。
3. 远程图片默认阻止或询问。
4. API Key 哈希存储。

### 第二阶段：业务策略

1. 邮箱有效期预设。
2. 分享有效期与数量策略。
3. API Key 生命周期策略。
4. 会话有效期。

### 第三阶段：体验和品牌

1. 站点名称、Logo、描述和主题色。
2. 默认语言与启用语言。
3. 用户阅读模式、远程图片和列表密度偏好。

### 第四阶段：集成能力

1. 通用 OIDC/Entra ID 网页登录。
2. Microsoft 365 IMAP/SMTP OAuth2。
3. Webhook 事件订阅和可靠性策略。
4. IMAP 全局并发与超时调优。

## 9. 设计原则

- 所有策略都必须由服务端执行，隐藏按钮不算权限控制。
- 管理员配置只定义上限，用户配置不能越过上限。
- 公开运行配置接口只能返回无密钥的安全子集。
- 新配置必须具备默认值、严格 schema、迁移策略和回归测试。
- 业务配置优先热更新；改变数据库驱动等基础设施设置仍可由守护进程安全重启。
- Worker 配置继续留在 Wrangler/Cloudflare；不要让 Worker 每次收信都依赖源站读取配置。
