import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { parse } from "yaml"

const CONFIG_PATH = "/app/data/config.yaml"
const LAST_KNOWN_GOOD_PATH = `${CONFIG_PATH}.lkg`

function readConfig(path = LAST_KNOWN_GOOD_PATH) {
  try {
    const parsed = parse(readFileSync(path, "utf8"), {
      prettyErrors: false,
    })
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("配置文件顶层必须是键值对")
    }
    return parsed
  } catch (error) {
    if (error?.code === "ENOENT") return null
    const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : "INVALID_CONFIG"
    console.error(`无法读取 ${path}: ${code}`)
    process.exit(65)
  }
}

function postgresConnectionTarget(config) {
  const urlValue = lookup(config, "database.postgres.url")
  if (typeof urlValue !== "string" || !urlValue) {
    throw new Error("database.postgres.url is required")
  }

  if (/[\u0000-\u0020\u007f]/.test(urlValue)) {
    throw new Error("PostgreSQL URL must percent-encode whitespace and control characters")
  }
  let databaseUrl
  try {
    databaseUrl = new URL(urlValue)
  } catch {
    throw new Error("database.postgres.url is invalid")
  }
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("database.postgres.url must use postgres or postgresql")
  }
  if (databaseUrl.searchParams.size > 0) {
    throw new Error(
      "PostgreSQL URL query parameters are not allowed; use the corresponding YAML fields",
    )
  }
  if (databaseUrl.hash) throw new Error("PostgreSQL URL fragments are not allowed")
  const encodedDatabase = databaseUrl.pathname.slice(1)
  if (encodedDatabase.includes("/")) {
    throw new Error("PostgreSQL database name slashes must be percent-encoded")
  }

  const target = {
    host: databaseUrl.hostname.replace(/^\[|\]$/g, ""),
    port: databaseUrl.port || "5432",
    database: decodeURIComponent(encodedDatabase),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
  }
  if (target.host.includes("%")) {
    throw new Error("PostgreSQL host must not contain percent-encoding")
  }
  if (!target.host || !target.database || !target.user) {
    throw new Error(
      "database.postgres.url must explicitly include a PostgreSQL host, database, and user",
    )
  }
  if (Object.values(target).some(value => value.includes("\0"))) {
    throw new Error("PostgreSQL connection fields cannot contain NUL bytes")
  }
  return target
}

function postgresTarget(config) {
  const { password: _password, ...target } = postgresConnectionTarget(config)
  return target
}

function conninfoQuote(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
}

function postgresConninfo(config) {
  const target = postgresConnectionTarget(config)
  return [
    `host=${conninfoQuote(target.host)}`,
    `port=${conninfoQuote(target.port)}`,
    `user=${conninfoQuote(target.user)}`,
    `dbname=${conninfoQuote(target.database)}`,
  ].join(" ")
}

function resolvePostgresSsl(config) {
  postgresTarget(config)
  const enabled = lookup(config, "database.postgres.ssl")
  const rejectUnauthorized = lookup(config, "database.postgres.sslRejectUnauthorized")
  if (typeof enabled !== "boolean" || typeof rejectUnauthorized !== "boolean") {
    throw new Error("PostgreSQL TLS settings must be booleans")
  }
  if (!enabled) return { mode: "disable", source: "yaml" }
  return {
    mode: rejectUnauthorized ? "verify-full" : "require",
    source: "yaml",
  }
}

function postgresSsl(config) {
  try {
    return resolvePostgresSsl(config)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "PostgreSQL config is invalid")
    process.exit(65)
  }
}

function lookup(config, path) {
  let value = config
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    value = value[segment]
  }
  return value
}

function requireExactObject(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object")
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("keys")
  }
  return value
}

function requireString(value, nullable = false) {
  if (nullable && value === null) return
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("string")
  }
}

function requireBoolean(value) {
  if (typeof value !== "boolean") throw new Error("boolean")
}

function requireInteger(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("integer")
  }
}

function requireHttpUrl(value, nullable = false) {
  requireString(value, nullable)
  if (nullable && value === null) return
  if (!/^https?:\/\/\S+$/i.test(value)) throw new Error("http-url")
}

function requireSecret(value, nullable = false) {
  requireString(value, nullable)
  if (nullable && value === null) return
  if (/\s/.test(value) || Buffer.byteLength(value, "utf8") < 32) throw new Error("secret")
  if (/(?:replace-with|change-me|not-for-production|paste[_-]a)/i.test(value)) {
    throw new Error("placeholder")
  }
}

function requireOauth(value) {
  const oauth = requireExactObject(value, ["clientId", "clientSecret"])
  requireString(oauth.clientId, true)
  requireString(oauth.clientSecret, true)
  if (Boolean(oauth.clientId) !== Boolean(oauth.clientSecret)) throw new Error("oauth-pair")
}

/** Docker PostgreSQL tools cannot import the TypeScript/Zod runtime. This mirrors
 * the serialized, default-expanded AppConfig shape conservatively: old or
 * truncated snapshots are retained for manual recovery instead of auto-pruned. */
function validateCompleteConfig(value) {
  const config = requireExactObject(value, [
    "version", "setup", "server", "database", "auth", "email",
    "cleanup", "scheduler", "monitor", "offsite",
  ])
  if (config.version !== 1) throw new Error("version")

  const setup = requireExactObject(config.setup, ["completed", "completedAt"])
  if (setup.completed !== true) throw new Error("setup")
  requireString(setup.completedAt, true)

  const server = requireExactObject(config.server, [
    "baseUrl", "trustProxyHeaders", "autoRestartOnDriverChange", "emailPollIntervalMs",
  ])
  requireHttpUrl(server.baseUrl)
  requireBoolean(server.trustProxyHeaders)
  requireBoolean(server.autoRestartOnDriverChange)
  requireInteger(server.emailPollIntervalMs, 5_000, 600_000)

  const database = requireExactObject(config.database, ["driver", "sqlite", "postgres"])
  if (database.driver !== "sqlite" && database.driver !== "postgres") throw new Error("driver")
  const sqlite = requireExactObject(database.sqlite, ["path", "backupDir", "backupRetentionDays"])
  requireString(sqlite.path)
  requireString(sqlite.backupDir)
  requireInteger(sqlite.backupRetentionDays, 1, 3_650)
  const pathWithinData = (path, allowRoot) => {
    const segments = path.split("/")
    return !path.includes("\\")
      && !segments.some(segment => segment === "" || segment === "." || segment === "..")
      && (allowRoot ? path === "data" || path.startsWith("data/") : path.startsWith("data/"))
  }
  const normalizedSqlitePath = sqlite.path.replace(/\\/g, "/").toLowerCase()
  const normalizedSqliteBackupDir = sqlite.backupDir.replace(/\\/g, "/").toLowerCase()
  const conflictsWithConfigControlPath = value => value === "data/config.yaml"
    || value.startsWith("data/config.yaml.")
    || value.startsWith("data/config.yaml/")
    || value === "data/setup-token"
    || value.startsWith("data/setup-token/")
    || value === "data/setup-operation.lock"
    || value.startsWith("data/setup-operation.lock/")
  const sqliteAuxiliaryFiles = [
    `${normalizedSqlitePath}-wal`,
    `${normalizedSqlitePath}-shm`,
    `${normalizedSqlitePath}-journal`,
    `${normalizedSqlitePath}.cleanup.lock`,
  ]
  if (
    !pathWithinData(sqlite.path, false)
    || !pathWithinData(sqlite.backupDir, true)
    || conflictsWithConfigControlPath(normalizedSqlitePath)
    || conflictsWithConfigControlPath(normalizedSqliteBackupDir)
    || normalizedSqliteBackupDir === normalizedSqlitePath
    || normalizedSqliteBackupDir.startsWith(`${normalizedSqlitePath}/`)
    || sqliteAuxiliaryFiles.some(path => (
      normalizedSqliteBackupDir === path
      || normalizedSqliteBackupDir.startsWith(`${path}/`)
    ))
  ) {
    throw new Error("sqlite-path")
  }

  const postgres = requireExactObject(database.postgres, [
    "url", "poolMax", "idleTimeoutMs", "connectTimeoutMs", "ssl",
    "sslRejectUnauthorized", "applicationName", "backupDir", "backupRetentionDays",
  ])
  requireString(postgres.url, true)
  requireInteger(postgres.poolMax, 1, 1_000)
  requireInteger(postgres.idleTimeoutMs, 1_000, 3_600_000)
  requireInteger(postgres.connectTimeoutMs, 1_000, 600_000)
  requireBoolean(postgres.ssl)
  requireBoolean(postgres.sslRejectUnauthorized)
  requireString(postgres.applicationName)
  requireString(postgres.backupDir)
  requireInteger(postgres.backupRetentionDays, 1, 3_650)
  if (
    postgres.backupDir !== "data/postgres-backups"
    && !postgres.backupDir.startsWith("data/postgres-backups/")
  ) throw new Error("postgres-backup-path")
  if (postgres.backupDir.includes("\\") || postgres.backupDir.split("/").some(
    segment => segment === "." || segment === "..",
  )) throw new Error("postgres-backup-path")
  if (database.driver === "postgres") {
    postgresTarget(config)
  }

  const auth = requireExactObject(config.auth, [
    "secret", "passwordPepper", "emperorBootstrapSecret", "github", "google", "rateLimit",
  ])
  requireSecret(auth.secret)
  requireSecret(auth.passwordPepper)
  requireSecret(auth.emperorBootstrapSecret, true)
  requireOauth(auth.github)
  requireOauth(auth.google)
  const rateLimit = requireExactObject(auth.rateLimit, [
    "windowSeconds", "loginPerClient", "loginGlobal", "registerPerClient",
    "registerGlobal", "maxClients", "scryptMaxConcurrency",
  ])
  requireInteger(rateLimit.windowSeconds, 10, 3_600)
  requireInteger(rateLimit.loginPerClient, 1, 100_000)
  requireInteger(rateLimit.loginGlobal, 1, 1_000_000)
  requireInteger(rateLimit.registerPerClient, 1, 100_000)
  requireInteger(rateLimit.registerGlobal, 1, 1_000_000)
  requireInteger(rateLimit.maxClients, 100, 1_000_000)
  requireInteger(rateLimit.scryptMaxConcurrency, 1, 32)

  const email = requireExactObject(config.email, ["ingestSecret"])
  requireSecret(email.ingestSecret)
  const secrets = [auth.secret, auth.passwordPepper, auth.emperorBootstrapSecret, email.ingestSecret]
    .filter(value => value !== null)
  if (new Set(secrets).size !== secrets.length) throw new Error("duplicate-secret")

  const cleanup = requireExactObject(config.cleanup, [
    "batchSize", "maxRows", "lockStaleMinutes", "permanentMessageRetentionDays",
  ])
  requireInteger(cleanup.batchSize, 1, 100_000)
  requireInteger(cleanup.maxRows, 1, 10_000_000)
  requireInteger(cleanup.lockStaleMinutes, 1, 10_080)
  requireInteger(cleanup.permanentMessageRetentionDays, 0, 36_500)

  const scheduler = requireExactObject(config.scheduler, [
    "cleanupIntervalSeconds", "backupIntervalSeconds", "backupOnStart",
  ])
  requireInteger(scheduler.cleanupIntervalSeconds, 60, 86_400)
  requireInteger(scheduler.backupIntervalSeconds, 300, 2_592_000)
  requireBoolean(scheduler.backupOnStart)

  const monitor = requireExactObject(config.monitor, [
    "intervalSeconds", "healthcheckUrl", "diskPath", "accessLog", "minFreePercent",
    "minFreeGb", "maxWalMb", "maxPostgresDatabaseGb", "windowMinutes", "maxHttp5xx",
    "maxIngestFailures", "alertWebhookUrl", "alertBearerToken",
  ])
  requireInteger(monitor.intervalSeconds, 30, 86_400)
  requireHttpUrl(monitor.healthcheckUrl, true)
  requireString(monitor.diskPath, true)
  requireString(monitor.accessLog, true)
  requireInteger(monitor.minFreePercent, 0, 100)
  requireInteger(monitor.minFreeGb, 0, 1_000_000)
  requireInteger(monitor.maxWalMb, 0, 1_000_000)
  requireInteger(monitor.maxPostgresDatabaseGb, 0, 1_000_000)
  requireInteger(monitor.windowMinutes, 1, 1_440)
  requireInteger(monitor.maxHttp5xx, 0, 1_000_000)
  requireInteger(monitor.maxIngestFailures, 0, 1_000_000)
  requireHttpUrl(monitor.alertWebhookUrl, true)
  requireString(monitor.alertBearerToken, true)

  const offsite = requireExactObject(config.offsite, [
    "remote", "intervalSeconds", "rcloneBin", "rcloneConfigContent",
  ])
  requireString(offsite.remote, true)
  requireInteger(offsite.intervalSeconds, 60, 604_800)
  requireString(offsite.rcloneBin)
  requireString(offsite.rcloneConfigContent, true)
  return config
}

let arguments_ = process.argv.slice(2)
let configPath = LAST_KNOWN_GOOD_PATH
if (arguments_[0] === "--file") {
  if (!arguments_[1]) {
    console.error("--file requires a path")
    process.exit(64)
  }
  configPath = arguments_[1]
  arguments_ = arguments_.slice(2)
}

const [command, key, fallback = ""] = arguments_
const config = readConfig(configPath)

if (command === "validate-complete") {
  try {
    validateCompleteConfig(config)
    process.stdout.write("ok")
    process.exit(0)
  } catch {
    console.error("配置快照不完整或不符合当前 schema")
    process.exit(65)
  }
}

if (command === "state") {
  process.stdout.write(config?.setup?.completed === true ? "ready" : "pending")
  process.exit(0)
}

if (command === "get") {
  if (!config || config.setup?.completed !== true) {
    console.error("MoeMail 尚未完成初始化")
    process.exit(75)
  }
  const value = lookup(config, key || "")
  if (value === undefined || value === null || value === "") {
    process.stdout.write(fallback)
  } else if (typeof value === "object") {
    process.stdout.write(JSON.stringify(value))
  } else {
    process.stdout.write(String(value))
  }
  process.exit(0)
}

if (command === "postgres-sslmode" || command === "postgres-sslmode-source") {
  if (!config || config.setup?.completed !== true) {
    console.error("MoeMail 尚未完成初始化")
    process.exit(75)
  }
  const ssl = postgresSsl(config)
  process.stdout.write(command.endsWith("source") ? ssl.source : ssl.mode)
  process.exit(0)
}

if (command === "postgres-target" || command === "postgres-fields" || command === "postgres-conninfo") {
  if (!config || config.setup?.completed !== true) {
    console.error("MoeMail 尚未完成初始化")
    process.exit(75)
  }
  try {
    const complete = validateCompleteConfig(config)
    if (complete.database.driver !== "postgres") throw new Error("database.driver is not postgres")
    const connection = postgresConnectionTarget(complete)
    if (command === "postgres-fields") {
      process.stdout.write([
        connection.host,
        connection.port,
        connection.user,
        connection.password,
        connection.database,
        "",
      ].join("\0"))
    } else if (command === "postgres-conninfo") {
      process.stdout.write(postgresConninfo(complete))
    } else {
      const { password: _password, ...target } = connection
      const tlsMode = resolvePostgresSsl(complete).mode
      process.stdout.write(JSON.stringify({ ...target, tlsMode }))
    }
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "PostgreSQL config is invalid")
    process.exit(65)
  }
}

if (command === "fingerprint") {
  if (!config || config.setup?.completed !== true) {
    console.error("MoeMail 尚未完成初始化")
    process.exit(75)
  }
  process.stdout.write(createHash("sha256").update(JSON.stringify(config)).digest("hex"))
  process.exit(0)
}

console.error(
  "Usage: config-reader.mjs [--file path] state | get <path> [fallback] | postgres-sslmode | postgres-sslmode-source | postgres-target | postgres-fields | postgres-conninfo | fingerprint | validate-complete",
)
process.exit(64)
