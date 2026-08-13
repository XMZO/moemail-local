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
  if (/\s/.test(value)) problems.push("SECRET_WHITESPACE_FORBIDDEN")
  if (Buffer.byteLength(value, "utf8") < MINIMUM_SECRET_BYTES) {
    problems.push("SECRET_TOO_SHORT")
  }
  if (PLACEHOLDER_PATTERN.test(value)) problems.push("SECRET_PLACEHOLDER_FORBIDDEN")
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
      .refine(value => /^https?:\/\/\S+$/i.test(value), "HTTP_URL_REQUIRED")
      .transform(value => value.replace(/\/+$/, "")),
  )
}

const nullableHttpUrl = nullableText.superRefine((value, ctx) => {
  if (value === null) return
  if (!/^https?:\/\/\S+$/i.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "HTTP_URL_REQUIRED",
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
      issue(["database", "postgres", "url"], "POSTGRES_URL_REQUIRED")
    } else {
      try {
        parsePostgresConnectionUrl(url)
      } catch {
        issue(["database", "postgres", "url"], "POSTGRES_URL_INVALID")
      }
    }
  }

  if (config.setup.completed) {
    if (!config.auth.secret) {
      issue(["auth", "secret"], "AUTH_SECRET_REQUIRED")
    }
    if (!config.auth.passwordPepper) {
      issue(["auth", "passwordPepper"], "PASSWORD_PEPPER_REQUIRED")
    }
    if (!config.email.ingestSecret) {
      issue(["email", "ingestSecret"], "EMAIL_INGEST_SECRET_REQUIRED")
    }
  }

  for (const provider of ["github", "google"] as const) {
    const { clientId, clientSecret } = config.auth[provider]
    if (Boolean(clientId) !== Boolean(clientSecret)) {
      issue(["auth", provider], "OAUTH_CREDENTIAL_PAIR_REQUIRED")
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
        issue(configured[right][0].split("."), "SECRET_VALUE_REUSED")
      }
    }
  }

  if (config.database.driver === "sqlite" && config.database.sqlite.path === ":memory:") {
    issue(["database", "sqlite", "path"], "SQLITE_MEMORY_DATABASE_FORBIDDEN")
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
      "SQLITE_PATH_OUTSIDE_DATA",
    )
  } else if (conflictsWithConfigControlPath(normalizedSqlitePath)) {
    issue(
      ["database", "sqlite", "path"],
      "CONFIG_CONTROL_PATH_CONFLICT",
    )
  }
  if (!pathWithinData(config.database.sqlite.backupDir, true)) {
    issue(
      ["database", "sqlite", "backupDir"],
      "SQLITE_BACKUP_DIR_OUTSIDE_DATA",
    )
  } else if (conflictsWithConfigControlPath(normalizedSqliteBackupDir)) {
    issue(
      ["database", "sqlite", "backupDir"],
      "CONFIG_CONTROL_PATH_CONFLICT",
    )
  }
  if (
    normalizedSqliteBackupDir === normalizedSqlitePath
    || normalizedSqliteBackupDir.startsWith(`${normalizedSqlitePath}/`)
  ) {
    issue(
      ["database", "sqlite", "backupDir"],
      "SQLITE_BACKUP_EQUALS_DATABASE_PATH",
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
      "SQLITE_BACKUP_AUXILIARY_PATH_CONFLICT",
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
      "POSTGRES_BACKUP_DIR_OUTSIDE_DATA",
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
    throw new Error(`DEFAULT_CONFIG_INVALID:${formatIssues(result.issues)}`)
  }
  return result.config
}

/** Web 进程只有数据库类型变化需要重启；其他运行配置均热加载。 */
export function requiresProcessRestart(previous: AppConfig, next: AppConfig) {
  return previous.database.driver !== next.database.driver
}
