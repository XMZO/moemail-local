import { z } from "zod"
import { parsePostgresConnectionUrl } from "../postgres-connection"

export const CONFIG_VERSION = 1

const MINIMUM_SECRET_BYTES = 32
const PLACEHOLDER_PATTERN = /(?:replace-with|change-me|not-for-production|paste[_-]a)/i

export interface ConfigIssue {
  path: string
  message: string
}

function withDefault(defaultValue: unknown) {
  return (value: unknown) => (
    value === undefined || value === null || value === "" ? defaultValue : value
  )
}

function text(defaultValue: string) {
  return z.preprocess(withDefault(defaultValue), z.string().trim().min(1))
}

const nullableText = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform(value => {
    if (value === null || value === undefined) return null
    const trimmed = String(value).trim()
    return trimmed.length > 0 ? trimmed : null
  })

function secretProblems(value: string) {
  const problems: string[] = []
  if (/\s/.test(value)) problems.push("不能包含空白字符")
  if (Buffer.byteLength(value, "utf8") < MINIMUM_SECRET_BYTES) {
    problems.push(`长度至少需要 ${MINIMUM_SECRET_BYTES} 字节`)
  }
  if (PLACEHOLDER_PATTERN.test(value)) problems.push("仍然是文档中的占位符")
  return problems
}

const nullableSecret = nullableText.superRefine((value, ctx) => {
  if (value === null) return
  for (const message of secretProblems(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  }
})

function integer(defaultValue: number, minimum: number, maximum: number) {
  return z.preprocess(value => {
    const withFallback = withDefault(defaultValue)(value)
    if (typeof withFallback === "string") {
      const parsed = Number(withFallback.trim())
      return Number.isNaN(parsed) ? withFallback : parsed
    }
    return withFallback
  }, z.number().int().min(minimum).max(maximum))
}

const TRUE_WORDS = new Set(["true", "yes", "on", "1"])
const FALSE_WORDS = new Set(["false", "no", "off", "0"])

function boolean(defaultValue: boolean) {
  return z.preprocess(value => {
    const withFallback = withDefault(defaultValue)(value)
    if (typeof withFallback === "string") {
      const normalized = withFallback.trim().toLowerCase()
      if (TRUE_WORDS.has(normalized)) return true
      if (FALSE_WORDS.has(normalized)) return false
    }
    return withFallback
  }, z.boolean())
}

function httpUrl(defaultValue: string) {
  return z.preprocess(
    withDefault(defaultValue),
    z
      .string()
      .trim()
      .refine(value => /^https?:\/\/\S+$/i.test(value), "必须是 http:// 或 https:// 开头的地址")
      .transform(value => value.replace(/\/+$/, "")),
  )
}

const nullableHttpUrl = nullableText.superRefine((value, ctx) => {
  if (value === null) return
  if (!/^https?:\/\/\S+$/i.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "必须是 http:// 或 https:// 开头的地址",
    })
  }
})

const driver = z.preprocess(value => {
  const withFallback = withDefault("sqlite")(value)
  if (typeof withFallback !== "string") return withFallback
  const normalized = withFallback.trim().toLowerCase()
  if (normalized === "postgresql" || normalized === "pgsql" || normalized === "pg") {
    return "postgres"
  }
  return normalized
}, z.enum(["sqlite", "postgres"]))

const oauthProvider = z
  .object({
    clientId: nullableText,
    clientSecret: nullableText,
  })
  .strict()
  .default({})

const baseConfigSchema = z.object({
  version: integer(CONFIG_VERSION, 1, CONFIG_VERSION),

  setup: z
    .object({
      completed: boolean(false),
      completedAt: nullableText,
    })
    .strict()
    .default({}),

  server: z
    .object({
      baseUrl: httpUrl("http://localhost:3000"),
      trustProxyHeaders: boolean(false),
      autoRestartOnDriverChange: boolean(true),
      emailPollIntervalMs: integer(25_000, 5_000, 600_000),
    })
    .strict()
    .default({}),

  database: z
    .object({
      driver,
      sqlite: z
        .object({
          path: text("data/moemail.db"),
          backupDir: text("data/backups"),
          backupRetentionDays: integer(30, 1, 3_650),
        })
        .strict()
        .default({}),
      postgres: z
        .object({
          url: nullableText,
          poolMax: integer(10, 1, 1_000),
          idleTimeoutMs: integer(30_000, 1_000, 3_600_000),
          connectTimeoutMs: integer(10_000, 1_000, 600_000),
          ssl: boolean(false),
          sslRejectUnauthorized: boolean(true),
          applicationName: text("moemail"),
          backupDir: text("data/postgres-backups"),
          backupRetentionDays: integer(14, 1, 3_650),
        })
        .strict()
        .default({}),
    })
    .strict()
    .default({}),

  auth: z
    .object({
      secret: nullableSecret,
      passwordPepper: nullableSecret,
      emperorBootstrapSecret: nullableSecret,
      github: oauthProvider,
      google: oauthProvider,
      rateLimit: z
        .object({
          windowSeconds: integer(300, 10, 3_600),
          loginPerClient: integer(20, 1, 100_000),
          loginGlobal: integer(300, 1, 1_000_000),
          registerPerClient: integer(5, 1, 100_000),
          registerGlobal: integer(60, 1, 1_000_000),
          maxClients: integer(10_000, 100, 1_000_000),
          scryptMaxConcurrency: integer(2, 1, 32),
        })
        .strict()
        .default({}),
    })
    .strict()
    .default({}),

  email: z
    .object({
      ingestSecret: nullableSecret,
    })
    .strict()
    .default({}),

  cleanup: z
    .object({
      batchSize: integer(500, 1, 100_000),
      maxRows: integer(50_000, 1, 10_000_000),
      lockStaleMinutes: integer(360, 1, 10_080),
      permanentMessageRetentionDays: integer(0, 0, 36_500),
    })
    .strict()
    .default({}),

  scheduler: z
    .object({
      cleanupIntervalSeconds: integer(3_600, 60, 86_400),
      backupIntervalSeconds: integer(86_400, 300, 2_592_000),
      backupOnStart: boolean(true),
    })
    .strict()
    .default({}),

  monitor: z
    .object({
      intervalSeconds: integer(300, 30, 86_400),
      healthcheckUrl: nullableHttpUrl,
      diskPath: nullableText,
      accessLog: nullableText,
      minFreePercent: integer(10, 0, 100),
      minFreeGb: integer(2, 0, 1_000_000),
      maxWalMb: integer(1_024, 0, 1_000_000),
      maxPostgresDatabaseGb: integer(0, 0, 1_000_000),
      windowMinutes: integer(5, 1, 1_440),
      maxHttp5xx: integer(0, 0, 1_000_000),
      maxIngestFailures: integer(0, 0, 1_000_000),
      alertWebhookUrl: nullableHttpUrl,
      alertBearerToken: nullableText,
    })
    .strict()
    .default({}),

  offsite: z
    .object({
      remote: nullableText,
      intervalSeconds: integer(3_600, 60, 604_800),
      rcloneBin: text("rclone"),
      rcloneConfigContent: nullableText,
    })
    .strict()
    .default({}),
}).strict()

export const configSchema = baseConfigSchema.superRefine((config, ctx) => {
  const issue = (path: (string | number)[], message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message })
  }

  if (config.database.driver === "postgres") {
    const url = config.database.postgres.url
    if (!url) {
      issue(["database", "postgres", "url"], "选择 PostgreSQL 时必须填写连接串")
    } else {
      try {
        parsePostgresConnectionUrl(url)
      } catch (error) {
        issue(
          ["database", "postgres", "url"],
          error instanceof Error ? error.message : "连接串不是有效的 PostgreSQL URL",
        )
      }
    }
  }

  if (config.setup.completed) {
    if (!config.auth.secret) {
      issue(["auth", "secret"], "初始化完成后必须配置会话密钥")
    }
    if (!config.auth.passwordPepper) {
      issue(["auth", "passwordPepper"], "初始化完成后必须配置密码 pepper")
    }
    if (!config.email.ingestSecret) {
      issue(["email", "ingestSecret"], "初始化完成后必须配置邮件投递密钥")
    }
  }

  for (const provider of ["github", "google"] as const) {
    const { clientId, clientSecret } = config.auth[provider]
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      issue(["auth", provider], "Client ID 与 Client Secret 必须同时填写或同时留空")
    }
  }

  const secrets: [string, string | null][] = [
    ["auth.secret", config.auth.secret],
    ["auth.passwordPepper", config.auth.passwordPepper],
    ["auth.emperorBootstrapSecret", config.auth.emperorBootstrapSecret],
    ["email.ingestSecret", config.email.ingestSecret],
  ]
  const configured = secrets.filter((entry): entry is [string, string] => entry[1] !== null)
  for (let left = 0; left < configured.length; left += 1) {
    for (let right = left + 1; right < configured.length; right += 1) {
      if (configured[left][1] === configured[right][1]) {
        issue(
          configured[right][0].split("."),
          `不能与 ${configured[left][0]} 使用相同的值`,
        )
      }
    }
  }

  if (config.database.driver === "sqlite" && config.database.sqlite.path === ":memory:") {
    issue(["database", "sqlite", "path"], "内存数据库无法持久化，请填写文件路径")
  }

  const pathWithinData = (value: string, allowDataRoot: boolean) => {
    const normalized = value.replace(/\\/g, "/")
    const segments = normalized.split("/")
    return !value.includes("\\")
      && !segments.some(segment => segment === "" || segment === "." || segment === "..")
      && (allowDataRoot ? normalized === "data" || normalized.startsWith("data/") : normalized.startsWith("data/"))
  }
  const normalizedSqlitePath = config.database.sqlite.path.replace(/\\/g, "/").toLowerCase()
  const normalizedSqliteBackupDir = config.database.sqlite.backupDir.replace(/\\/g, "/").toLowerCase()
  const conflictsWithConfigControlPath = (value: string) => {
    return value === "data/config.yaml"
      || value.startsWith("data/config.yaml.")
      || value.startsWith("data/config.yaml/")
      || value === "data/setup-token"
      || value.startsWith("data/setup-token/")
      || value === "data/setup-operation.lock"
      || value.startsWith("data/setup-operation.lock/")
  }
  if (!pathWithinData(config.database.sqlite.path, false)) {
    issue(
      ["database", "sqlite", "path"],
      "必须是 data/ 目录内的相对文件路径，确保所有容器共享并持久化数据库",
    )
  } else if (conflictsWithConfigControlPath(normalizedSqlitePath)) {
    issue(
      ["database", "sqlite", "path"],
      "不能占用 config.yaml、LKG、setup token 或配置锁使用的控制路径",
    )
  }
  if (!pathWithinData(config.database.sqlite.backupDir, true)) {
    issue(
      ["database", "sqlite", "backupDir"],
      "必须位于 data/ 目录内，确保备份卷持久化并可供异地同步读取",
    )
  } else if (conflictsWithConfigControlPath(normalizedSqliteBackupDir)) {
    issue(
      ["database", "sqlite", "backupDir"],
      "不能占用 config.yaml、LKG、setup token 或配置锁使用的控制路径",
    )
  }
  if (
    normalizedSqliteBackupDir === normalizedSqlitePath
    || normalizedSqliteBackupDir.startsWith(`${normalizedSqlitePath}/`)
  ) {
    issue(
      ["database", "sqlite", "backupDir"],
      "备份目录不能等于 SQLite 数据库文件，也不能位于该文件路径之下",
    )
  }
  const sqliteAuxiliaryFiles = [
    `${normalizedSqlitePath}-wal`,
    `${normalizedSqlitePath}-shm`,
    `${normalizedSqlitePath}-journal`,
    `${normalizedSqlitePath}.cleanup.lock`,
  ]
  if (sqliteAuxiliaryFiles.some(path => (
    normalizedSqliteBackupDir === path
    || normalizedSqliteBackupDir.startsWith(`${path}/`)
  ))) {
    issue(
      ["database", "sqlite", "backupDir"],
      "备份目录不能占用 SQLite WAL、SHM、journal 或 cleanup lock 路径",
    )
  }

  const postgresBackupDir = config.database.postgres.backupDir.replace(/\\/g, "/")
  const postgresBackupSegments = postgresBackupDir.split("/")
  if (
    config.database.postgres.backupDir.includes("\\")
    || postgresBackupSegments.some(segment => segment === "." || segment === "..")
    || (
      postgresBackupDir !== "data/postgres-backups"
      && !postgresBackupDir.startsWith("data/postgres-backups/")
    )
  ) {
    issue(
      ["database", "postgres", "backupDir"],
      "必须位于 data/postgres-backups 目录内，确保备份卷持久化并可供异地同步读取",
    )
  }
})

export type AppConfig = z.infer<typeof configSchema>
export type ConfigInput = z.input<typeof configSchema>

export type ParseResult =
  | { ok: true; config: AppConfig }
  | { ok: false; issues: ConfigIssue[] }

export function parseConfig(input: unknown): ParseResult {
  const result = configSchema.safeParse(input ?? {})
  if (result.success) return { ok: true, config: result.data }

  return {
    ok: false,
    issues: result.error.issues.map(issue => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  }
}

export function formatIssues(issues: ConfigIssue[]) {
  return issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")
}

export function createDefaultConfig(): AppConfig {
  const result = parseConfig({})
  if (!result.ok) {
    throw new Error(`默认配置无法通过校验: ${formatIssues(result.issues)}`)
  }
  return result.config
}

/** Web 进程只有数据库类型变化需要重启；其他运行配置均热加载。 */
export function requiresProcessRestart(previous: AppConfig, next: AppConfig) {
  return previous.database.driver !== next.database.driver
}
