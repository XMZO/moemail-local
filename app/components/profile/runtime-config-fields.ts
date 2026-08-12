export type RuntimeFieldKind = "text" | "number" | "boolean" | "secret" | "textarea" | "select"

export interface RuntimeFieldMetadata {
  label: string
  description: string
  kind?: RuntimeFieldKind
  options?: Array<{ value: string; label: string }>
}

export const runtimeGroupLabels: Record<string, string> = {
  root: "格式版本",
  setup: "初始化状态",
  server: "Web 服务",
  database: "数据库",
  auth: "登录与鉴权",
  email: "收件入口",
  cleanup: "数据清理",
  scheduler: "维护调度",
  monitor: "监控告警",
  offsite: "异地备份",
}

export const runtimeGroupOrder = [
  "server", "database", "auth", "email", "cleanup", "scheduler", "monitor", "offsite", "setup", "root",
]

export const runtimeConfigFields: Record<string, RuntimeFieldMetadata> = {
  version: { label: "Schema 版本", description: "当前只支持版本 1。", kind: "number" },
  "setup.completed": { label: "初始化完成", description: "由首次向导维护；关闭后会重新启用 setup gate。", kind: "boolean" },
  "setup.completedAt": { label: "初始化完成时间", description: "ISO 时间；留空表示未知。" },
  "server.baseUrl": { label: "站点基准 URL", description: "用于 metadata 与绝对链接，例如 https://mail.example.com。" },
  "server.trustProxyHeaders": { label: "信任反代请求头", description: "仅在受控 Caddy/反向代理后开启。", kind: "boolean" },
  "server.autoRestartOnDriverChange": { label: "切换驱动时自动退出", description: "生产环境由 Docker/systemd 守护进程拉起。", kind: "boolean" },
  "server.emailPollIntervalMs": { label: "邮箱轮询间隔（ms）", description: "浏览器刷新邮件列表的间隔。", kind: "number" },
  "database.driver": { label: "数据库驱动", description: "跨驱动切换会验证目标库并要求进程重启。", kind: "select", options: [{ value: "sqlite", label: "SQLite" }, { value: "postgres", label: "PostgreSQL" }] },
  "database.sqlite.path": { label: "SQLite 文件", description: "必须位于 data/ 目录内。" },
  "database.sqlite.backupDir": { label: "SQLite 备份目录", description: "必须位于 data/ 目录内且不能与数据库辅助文件冲突。" },
  "database.sqlite.backupRetentionDays": { label: "SQLite 备份保留天数", description: "维护任务只清理带严格配置 pair 的归档。", kind: "number" },
  "database.postgres.url": { label: "PostgreSQL URL", description: "禁止 query 参数；凭据保存在本地 0600 配置中。", kind: "secret" },
  "database.postgres.poolMax": { label: "连接池上限", description: "Web 进程最大数据库连接数。", kind: "number" },
  "database.postgres.idleTimeoutMs": { label: "空闲连接超时（ms）", description: "连接池释放空闲连接的时间。", kind: "number" },
  "database.postgres.connectTimeoutMs": { label: "连接超时（ms）", description: "配置探测与运行连接的超时。", kind: "number" },
  "database.postgres.ssl": { label: "启用 PostgreSQL TLS", description: "同时应用于 Web 与维护工具。", kind: "boolean" },
  "database.postgres.sslRejectUnauthorized": { label: "严格校验证书", description: "生产外部 PostgreSQL 建议开启。", kind: "boolean" },
  "database.postgres.applicationName": { label: "连接应用名", description: "显示在 PostgreSQL 活动连接中。" },
  "database.postgres.backupDir": { label: "PostgreSQL 备份目录", description: "必须位于 data/postgres-backups。" },
  "database.postgres.backupRetentionDays": { label: "PostgreSQL 备份保留天数", description: "Node 与工具容器共同使用。", kind: "number" },
  "auth.secret": { label: "会话签名密钥", description: "初始化后必填；不要与其他密钥复用。", kind: "secret" },
  "auth.passwordPepper": { label: "密码 Pepper", description: "初始化后禁止直接轮换，否则现有密码失效。", kind: "secret" },
  "auth.emperorBootstrapSecret": { label: "皇帝引导密钥", description: "首次初始化恢复用；通常无需手改。", kind: "secret" },
  "auth.github.clientId": { label: "GitHub Client ID", description: "与 Client Secret 同时配置。" },
  "auth.github.clientSecret": { label: "GitHub Client Secret", description: "OAuth 客户端密钥。", kind: "secret" },
  "auth.google.clientId": { label: "Google Client ID", description: "与 Client Secret 同时配置。" },
  "auth.google.clientSecret": { label: "Google Client Secret", description: "OAuth 客户端密钥。", kind: "secret" },
  "auth.rateLimit.windowSeconds": { label: "限流窗口（秒）", description: "登录与注册计数窗口。", kind: "number" },
  "auth.rateLimit.loginPerClient": { label: "单客户端登录上限", description: "每个窗口的尝试次数。", kind: "number" },
  "auth.rateLimit.loginGlobal": { label: "全局登录上限", description: "每个窗口的总尝试次数。", kind: "number" },
  "auth.rateLimit.registerPerClient": { label: "单客户端注册上限", description: "每个窗口的尝试次数。", kind: "number" },
  "auth.rateLimit.registerGlobal": { label: "全局注册上限", description: "每个窗口的总尝试次数。", kind: "number" },
  "auth.rateLimit.maxClients": { label: "限流客户端容量", description: "内存限流表最多保留的客户端。", kind: "number" },
  "auth.rateLimit.scryptMaxConcurrency": { label: "Scrypt 最大并发", description: "限制高成本密码运算并发。", kind: "number" },
  "email.ingestSecret": { label: "Worker 投递密钥", description: "Cloudflare Email Worker 调用内部收件 API。", kind: "secret" },
  "cleanup.batchSize": { label: "清理批大小", description: "单次删除循环处理的行数。", kind: "number" },
  "cleanup.maxRows": { label: "单次清理上限", description: "防止一次维护任务运行过久。", kind: "number" },
  "cleanup.lockStaleMinutes": { label: "清理锁期限（分钟）", description: "仅用于维护锁异常判断。", kind: "number" },
  "cleanup.permanentMessageRetentionDays": { label: "永久邮箱邮件保留天数", description: "0 表示永久邮箱消息不按年龄清理。", kind: "number" },
  "scheduler.cleanupIntervalSeconds": { label: "清理间隔（秒）", description: "scheduler profile 动态读取。", kind: "number" },
  "scheduler.backupIntervalSeconds": { label: "备份间隔（秒）", description: "scheduler profile 动态读取。", kind: "number" },
  "scheduler.backupOnStart": { label: "启动时立即备份", description: "调度器启动后先创建一次恢复点。", kind: "boolean" },
  "monitor.intervalSeconds": { label: "监控间隔（秒）", description: "monitoring profile 检查周期。", kind: "number" },
  "monitor.healthcheckUrl": { label: "健康检查 URL", description: "留空使用当前服务默认地址。" },
  "monitor.diskPath": { label: "磁盘监控路径", description: "留空按数据库驱动选择默认数据路径。" },
  "monitor.accessLog": { label: "访问日志路径", description: "可选，用于统计 HTTP 5xx 与投递失败。" },
  "monitor.minFreePercent": { label: "最小剩余百分比", description: "低于阈值触发告警；0 关闭。", kind: "number" },
  "monitor.minFreeGb": { label: "最小剩余空间（GiB）", description: "低于阈值触发告警；0 关闭。", kind: "number" },
  "monitor.maxWalMb": { label: "最大 WAL（MiB）", description: "超出阈值触发告警；0 关闭。", kind: "number" },
  "monitor.maxPostgresDatabaseGb": { label: "最大 PG 库大小（GiB）", description: "超出阈值触发告警；0 关闭。", kind: "number" },
  "monitor.windowMinutes": { label: "日志统计窗口（分钟）", description: "HTTP/投递失败计数窗口。", kind: "number" },
  "monitor.maxHttp5xx": { label: "窗口内最大 5xx", description: "超过触发告警；0 关闭。", kind: "number" },
  "monitor.maxIngestFailures": { label: "窗口内最大投递失败", description: "超过触发告警；0 关闭。", kind: "number" },
  "monitor.alertWebhookUrl": { label: "告警 Webhook URL", description: "可选的外部告警目标。" },
  "monitor.alertBearerToken": { label: "告警 Bearer Token", description: "发送告警时附带的密钥。", kind: "secret" },
  "offsite.remote": { label: "Rclone 远端", description: "例如 remote:moemail；留空关闭异地同步。" },
  "offsite.intervalSeconds": { label: "异地同步间隔（秒）", description: "offsite profile 动态读取。", kind: "number" },
  "offsite.rcloneBin": { label: "Rclone 可执行文件", description: "容器默认 rclone。" },
  "offsite.rcloneConfigContent": { label: "Rclone 配置内容", description: "完整敏感配置，运行时写入私有临时文件。", kind: "textarea" },
}
