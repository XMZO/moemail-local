/**
 * 初始化向导与系统配置面板的文案。
 * 这两个界面只面向服务器运维者，因此不走 next-intl 的按需加载，
 * 直接内置 zh-CN / zh-TW / en 三套文案，其余语言回退到 en。
 */
export interface SetupDictionary {
  title: string
  subtitle: string
  configPath: string
  setupToken: string
  setupTokenHint: string
  setupTokenFile: string
  insecureTitle: string
  insecureHint: string
  existingConfigInvalid: string
  requestFailed: string
  siteSection: string
  baseUrl: string
  baseUrlHint: string
  trustProxy: string
  trustProxyHint: string
  pollInterval: string
  pollIntervalHint: string
  databaseSection: string
  driver: string
  sqlite: string
  postgres: string
  sqlitePath: string
  sqlitePathHint: string
  postgresUrl: string
  postgresUrlHint: string
  postgresSsl: string
  postgresSslStrict: string
  testConnection: string
  testing: string
  testOk: string
  adminSection: string
  username: string
  password: string
  confirmPassword: string
  adminHint: string
  optionalSection: string
  githubClientId: string
  githubClientSecret: string
  googleClientId: string
  googleClientSecret: string
  oauthHint: string
  advancedSection: string
  advancedHint: string
  submit: string
  submitting: string
  passwordMismatch: string
  doneTitle: string
  doneHint: string
  ingestSecret: string
  ingestSecretHint: string
  copy: string
  copied: string
  restartTitle: string
  restartHint: string
  waitingRestart: string
  enter: string
  failed: string
}

const zhCN: SetupDictionary = {
  title: "初始化 MoeMail",
  subtitle: "所有设置都会写入本地配置文件，之后可以在 WebUI 或直接编辑该文件修改。",
  configPath: "配置文件",
  setupToken: "一次性初始化令牌",
  setupTokenHint: "从容器/服务日志中的 setup.token.ready 事件复制。初始化成功后令牌文件会自动删除。",
  setupTokenFile: "令牌文件",
  insecureTitle: "当前是公网 IP 明文 HTTP",
  insecureHint: "管理员密码、数据库连接串和 OAuth 密钥会明文传输。仅使用测试凭据；正式使用前请配置 HTTPS 后再更换所有凭据。",
  existingConfigInvalid: "现有配置文件无法加载。提交有效设置后会覆盖该文件；失败时不会应用新配置。",
  requestFailed: "无法连接服务器，请检查网络后重试",
  siteSection: "站点",
  baseUrl: "站点地址",
  baseUrlHint: "对外访问地址，用于生成绝对链接。",
  trustProxy: "信任反向代理头",
  trustProxyHint: "仅当 MoeMail 位于你自己的反向代理之后时开启，用于按客户端 IP 限流。",
  pollInterval: "邮件轮询间隔（毫秒）",
  pollIntervalHint: "前端刷新收件箱的间隔，最小 5000。",
  databaseSection: "数据库",
  driver: "数据库类型",
  sqlite: "SQLite（单实例，默认）",
  postgres: "PostgreSQL（多实例 / 高并发）",
  sqlitePath: "数据库文件路径",
  sqlitePathHint: "必须位于持久化目录；默认 data/moemail.db 在容器内是 /app/data/moemail.db。",
  postgresUrl: "连接串",
  postgresUrlHint: "形如 postgres://user:password@host:5432/moemail；请移除 URL 中的 sslmode，改用下方 TLS 开关。",
  postgresSsl: "启用 SSL",
  postgresSslStrict: "校验服务端证书",
  testConnection: "测试连接",
  testing: "连接中…",
  testOk: "连接成功",
  adminSection: "站主账号",
  username: "用户名",
  password: "密码",
  confirmPassword: "确认密码",
  adminHint: "该账号会被授予皇帝（网站所有者）角色。",
  optionalSection: "可选：OAuth 登录",
  githubClientId: "GitHub Client ID",
  githubClientSecret: "GitHub Client Secret",
  googleClientId: "Google Client ID",
  googleClientSecret: "Google Client Secret",
  oauthHint: "留空表示不启用；Client ID 与 Secret 必须成对填写。",
  advancedSection: "高级：其余运行配置（YAML）",
  advancedHint: "可在首次提交前调整连接池、备份、清理、调度、监控、限流和异地同步。上方结构化表单中的同名值优先；此处不会显示自动生成的密钥。",
  submit: "完成初始化",
  submitting: "正在初始化…",
  passwordMismatch: "两次输入的密码不一致",
  doneTitle: "初始化完成",
  doneHint: "配置已写入文件，密钥已随机生成。",
  ingestSecret: "邮件投递密钥",
  ingestSecretHint: "Cloudflare Email Worker 需要它，请立即保存；之后也可在「运行配置」中查看。",
  copy: "复制",
  copied: "已复制",
  restartTitle: "需要重启进程",
  restartHint: "数据库类型已切换。production 且开启自动重启时 Docker / systemd 会拉起新进程；否则请手动重启。",
  waitingRestart: "等待服务重启…",
  enter: "进入 MoeMail",
  failed: "初始化失败",
}

const zhTW: SetupDictionary = {
  ...zhCN,
  title: "初始化 MoeMail",
  subtitle: "所有設定都會寫入本機設定檔，之後可以在 WebUI 或直接編輯該檔案修改。",
  configPath: "設定檔",
  setupToken: "一次性初始化權杖",
  setupTokenHint: "從容器/服務日誌的 setup.token.ready 事件複製。初始化成功後權杖檔案會自動刪除。",
  setupTokenFile: "權杖檔案",
  insecureTitle: "目前是公網 IP 明文 HTTP",
  insecureHint: "管理員密碼、資料庫連線字串與 OAuth 密鑰會以明文傳輸。僅使用測試憑據；正式使用前請設定 HTTPS 並更換所有憑據。",
  existingConfigInvalid: "現有設定檔無法載入。提交有效設定後會覆蓋該檔案；失敗時不會套用新設定。",
  requestFailed: "無法連線伺服器，請檢查網路後重試",
  siteSection: "站台",
  baseUrl: "站台網址",
  baseUrlHint: "對外存取網址，用於產生絕對連結。",
  trustProxy: "信任反向代理標頭",
  trustProxyHint: "僅當 MoeMail 位於你自己的反向代理之後時開啟，用於依用戶端 IP 限流。",
  pollInterval: "郵件輪詢間隔（毫秒）",
  pollIntervalHint: "前端重新整理收件匣的間隔，最小 5000。",
  databaseSection: "資料庫",
  driver: "資料庫類型",
  sqlite: "SQLite（單執行個體，預設）",
  postgres: "PostgreSQL（多執行個體 / 高併發）",
  sqlitePath: "資料庫檔案路徑",
  sqlitePathHint: "必須位於持久化目錄；預設 data/moemail.db 在容器內是 /app/data/moemail.db。",
  postgresUrl: "連線字串",
  postgresUrlHint: "形如 postgres://user:password@host:5432/moemail；請移除 URL 中的 sslmode，改用下方 TLS 開關。",
  postgresSsl: "啟用 SSL",
  postgresSslStrict: "驗證伺服器憑證",
  testConnection: "測試連線",
  testing: "連線中…",
  testOk: "連線成功",
  adminSection: "站主帳號",
  username: "使用者名稱",
  password: "密碼",
  confirmPassword: "確認密碼",
  adminHint: "此帳號會被授予皇帝（網站擁有者）角色。",
  optionalSection: "選用：OAuth 登入",
  oauthHint: "留空表示不啟用；Client ID 與 Secret 必須成對填寫。",
  advancedSection: "進階：其餘執行設定（YAML）",
  advancedHint: "可在首次提交前調整連線池、備份、清理、排程、監控、限流與異地同步。上方結構化表單的同名值優先；此處不會顯示自動產生的密鑰。",
  submit: "完成初始化",
  submitting: "正在初始化…",
  passwordMismatch: "兩次輸入的密碼不一致",
  doneTitle: "初始化完成",
  doneHint: "設定已寫入檔案，密鑰已隨機產生。",
  ingestSecret: "郵件投遞密鑰",
  ingestSecretHint: "Cloudflare Email Worker 需要它，請立即保存；之後也可在「執行設定」中檢視。",
  copy: "複製",
  copied: "已複製",
  restartTitle: "需要重新啟動行程",
  restartHint: "資料庫類型已切換。production 且開啟自動重啟時 Docker / systemd 會拉起新行程；否則請手動重新啟動。",
  waitingRestart: "等待服務重新啟動…",
  enter: "進入 MoeMail",
  failed: "初始化失敗",
}

const en: SetupDictionary = {
  title: "Set up MoeMail",
  subtitle: "Everything is written to a local config file that you can edit later, in the WebUI or by hand.",
  configPath: "Config file",
  setupToken: "One-time setup token",
  setupTokenHint: "Copy it from the setup.token.ready event in the container/service logs. Its file is deleted after setup succeeds.",
  setupTokenFile: "Token file",
  insecureTitle: "This is plain HTTP on a public IP",
  insecureHint: "The owner password, database URL, and OAuth secrets travel in clear text. Use test credentials only; enable HTTPS and rotate every credential before production use.",
  existingConfigInvalid: "The existing config file cannot be loaded. Valid settings will replace it; failed changes are not applied.",
  requestFailed: "Cannot reach the server. Check the network and retry.",
  siteSection: "Site",
  baseUrl: "Base URL",
  baseUrlHint: "Public address of this instance; used to build absolute links.",
  trustProxy: "Trust proxy headers",
  trustProxyHint: "Enable only behind your own reverse proxy; used for per-client rate limiting.",
  pollInterval: "Mailbox poll interval (ms)",
  pollIntervalHint: "How often the UI refreshes the inbox. Minimum 5000.",
  databaseSection: "Database",
  driver: "Engine",
  sqlite: "SQLite (single instance, default)",
  postgres: "PostgreSQL (multi-instance / high volume)",
  sqlitePath: "Database file",
  sqlitePathHint: "Must live on persistent storage; data/moemail.db resolves to /app/data/moemail.db in the container.",
  postgresUrl: "Connection string",
  postgresUrlHint: "postgres://user:password@host:5432/moemail; remove sslmode from the URL and use the TLS switches below.",
  postgresSsl: "Use SSL",
  postgresSslStrict: "Verify server certificate",
  testConnection: "Test connection",
  testing: "Connecting…",
  testOk: "Connection succeeded",
  adminSection: "Owner account",
  username: "Username",
  password: "Password",
  confirmPassword: "Confirm password",
  adminHint: "This account is granted the emperor (site owner) role.",
  optionalSection: "Optional: OAuth sign-in",
  githubClientId: "GitHub Client ID",
  githubClientSecret: "GitHub Client Secret",
  googleClientId: "Google Client ID",
  googleClientSecret: "Google Client Secret",
  oauthHint: "Leave blank to disable. Client ID and secret must be provided together.",
  advancedSection: "Advanced runtime settings (YAML)",
  advancedHint: "Adjust pooling, backups, cleanup, scheduling, monitoring, rate limits, and offsite sync before the first save. Structured fields above take precedence; generated secrets are never shown here.",
  submit: "Finish setup",
  submitting: "Setting up…",
  passwordMismatch: "Passwords do not match",
  doneTitle: "Setup complete",
  doneHint: "The config file has been written and secrets were generated for you.",
  ingestSecret: "Email ingest secret",
  ingestSecretHint: "The Cloudflare Email Worker needs this. Save it now; you can also read it later in Runtime Configuration.",
  copy: "Copy",
  copied: "Copied",
  restartTitle: "Restart required",
  restartHint: "The database engine changed. In production with auto-restart enabled, Docker / systemd starts the new process; otherwise restart it manually.",
  waitingRestart: "Waiting for the service to come back…",
  enter: "Open MoeMail",
  failed: "Setup failed",
}

const DICTIONARIES: Record<string, SetupDictionary> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
}

export function setupDictionary(locale: string): SetupDictionary {
  return DICTIONARIES[locale] ?? en
}
