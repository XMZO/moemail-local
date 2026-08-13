export type RuntimeFieldKind = "text" | "number" | "boolean" | "secret" | "textarea" | "select"

export interface RuntimeFieldMetadata {
  kind?: RuntimeFieldKind
  options?: Array<{ value: string; label: string }>
  required?: boolean
  secretAction?: "generate"
}

export const runtimeGroupOrder = [
  "server", "database", "auth", "email", "cleanup", "scheduler", "monitor", "offsite", "setup", "root",
] as const

// This file describes behavior only. All user-facing labels and help text live in
// i18n/messages/<locale>/runtime.json and are validated against these paths.
export const runtimeConfigFields: Record<string, RuntimeFieldMetadata> = {
  version: { kind: "number" },
  "setup.completed": { kind: "boolean" },
  "setup.completedAt": {},
  "server.baseUrl": {},
  "server.trustProxyHeaders": { kind: "boolean" },
  "server.autoRestartOnDriverChange": { kind: "boolean" },
  "server.emailPollIntervalMs": { kind: "number" },
  "database.driver": { kind: "select", options: [{ value: "sqlite", label: "SQLite" }, { value: "postgres", label: "PostgreSQL" }] },
  "database.sqlite.path": {},
  "database.sqlite.backupDir": {},
  "database.sqlite.backupRetentionDays": { kind: "number" },
  "database.postgres.url": { kind: "secret" },
  "database.postgres.poolMax": { kind: "number" },
  "database.postgres.idleTimeoutMs": { kind: "number" },
  "database.postgres.connectTimeoutMs": { kind: "number" },
  "database.postgres.ssl": { kind: "boolean" },
  "database.postgres.sslRejectUnauthorized": { kind: "boolean" },
  "database.postgres.applicationName": {},
  "database.postgres.backupDir": {},
  "database.postgres.backupRetentionDays": { kind: "number" },
  "auth.secret": { kind: "secret", required: true, secretAction: "generate" },
  "auth.passwordPepper": { kind: "secret", required: true },
  "auth.emperorBootstrapSecret": { kind: "secret", secretAction: "generate" },
  "auth.github.clientId": {},
  "auth.github.clientSecret": { kind: "secret" },
  "auth.google.clientId": {},
  "auth.google.clientSecret": { kind: "secret" },
  "auth.rateLimit.windowSeconds": { kind: "number" },
  "auth.rateLimit.loginPerClient": { kind: "number" },
  "auth.rateLimit.loginGlobal": { kind: "number" },
  "auth.rateLimit.registerPerClient": { kind: "number" },
  "auth.rateLimit.registerGlobal": { kind: "number" },
  "auth.rateLimit.maxClients": { kind: "number" },
  "auth.rateLimit.scryptMaxConcurrency": { kind: "number" },
  "email.ingestSecret": { kind: "secret", required: true, secretAction: "generate" },
  "cleanup.batchSize": { kind: "number" },
  "cleanup.maxRows": { kind: "number" },
  "cleanup.lockStaleMinutes": { kind: "number" },
  "cleanup.permanentMessageRetentionDays": { kind: "number" },
  "scheduler.cleanupIntervalSeconds": { kind: "number" },
  "scheduler.backupIntervalSeconds": { kind: "number" },
  "scheduler.backupOnStart": { kind: "boolean" },
  "monitor.intervalSeconds": { kind: "number" },
  "monitor.healthcheckUrl": {},
  "monitor.diskPath": {},
  "monitor.accessLog": {},
  "monitor.minFreePercent": { kind: "number" },
  "monitor.minFreeGb": { kind: "number" },
  "monitor.maxWalMb": { kind: "number" },
  "monitor.maxPostgresDatabaseGb": { kind: "number" },
  "monitor.windowMinutes": { kind: "number" },
  "monitor.maxHttp5xx": { kind: "number" },
  "monitor.maxIngestFailures": { kind: "number" },
  "monitor.alertWebhookUrl": {},
  "monitor.alertBearerToken": { kind: "secret", secretAction: "generate" },
  "offsite.remote": {},
  "offsite.intervalSeconds": { kind: "number" },
  "offsite.rcloneBin": {},
  "offsite.rcloneConfigContent": { kind: "textarea" },
}
