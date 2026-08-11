import Database from "better-sqlite3"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { Pool, type PoolConfig } from "pg"
import { getConfig, markRestartRequired } from "./config/runtime"
import type { AppConfig, ConfigIssue } from "./config/schema"
import {
  getBoundDriver,
  getConfiguredDriver,
  type DatabaseDriver,
} from "./database-dialect"
import * as localPostgresSchema from "./local-schema.postgres"
import * as localSqliteSchema from "./local-schema.sqlite"
import * as postgresSchema from "./schema.postgres"
import * as sqliteSchema from "./schema.sqlite"
import {
  discardInheritedPostgresEnvironment,
  parsePostgresConnectionUrl,
} from "./postgres-connection"

const sqliteCombinedSchema = { ...sqliteSchema, ...localSqliteSchema }
const postgresCombinedSchema = { ...postgresSchema, ...localPostgresSchema }

/** 旧连接延迟关闭，避免关掉正在处理请求的句柄。 */
const CONNECTION_DRAIN_MS = 5_000

export function resolveSqlitePath(config: AppConfig = getConfig()) {
  return resolve(process.cwd(), config.database.sqlite.path)
}

export function openSqliteConnection(config: AppConfig) {
  const databasePath = resolveSqlitePath(config)
  mkdirSync(dirname(databasePath), { recursive: true })

  const sqlite = new Database(databasePath, { timeout: 5_000 })
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  sqlite.pragma("busy_timeout = 5000")
  sqlite.pragma("synchronous = NORMAL")
  return { sqlite, databasePath }
}

function postgresSsl(config: AppConfig): PoolConfig["ssl"] {
  // 必须显式传 false；undefined 会让 node-postgres 回退读取 PGSSLMODE。
  if (!config.database.postgres.ssl) return false
  return { rejectUnauthorized: config.database.postgres.sslRejectUnauthorized }
}

export function postgresPoolConfig(config: AppConfig): PoolConfig {
  const { postgres } = config.database
  if (!postgres.url) {
    throw new Error("数据库类型为 postgres 时必须配置 database.postgres.url")
  }
  const target = parsePostgresConnectionUrl(postgres.url)
  discardInheritedPostgresEnvironment()

  return {
    host: target.host,
    port: Number(target.port),
    database: target.database,
    user: target.user,
    // 函数本身为 truthy，即使密码为空也不会回退 PGPASSWORD/.pgpass。
    password: () => target.password,
    max: postgres.poolMax,
    idleTimeoutMillis: postgres.idleTimeoutMs,
    connectionTimeoutMillis: postgres.connectTimeoutMs,
    keepAlive: true,
    ssl: postgresSsl(config),
    application_name: postgres.applicationName,
    // 显式值阻断 PGOPTIONS/PGCLIENTENCODING/PGREPLICATION 继承。
    options: " ",
    client_encoding: "UTF8",
    ...({ replication: "false" } as Record<string, string>),
  }
}

export function createPostgresPool(config: AppConfig) {
  const pool = new Pool(postgresPoolConfig(config))
  pool.on("error", error => {
    console.error("Unexpected PostgreSQL pool error", error)
  })
  return pool
}

const createSqliteDrizzle = (sqlite: Database.Database) => (
  drizzleSqlite(sqlite, { schema: sqliteCombinedSchema })
)

const createPostgresDrizzle = (pool: Pool) => (
  drizzlePostgres(pool, { schema: postgresCombinedSchema })
)

type AppDb = ReturnType<typeof createSqliteDrizzle>

interface Connection {
  signature: string
  driver: "sqlite" | "postgres"
  databasePath?: string
  sqlite?: Database.Database
  pool?: Pool
  db: AppDb
}

type DbGlobals = typeof globalThis & {
  __moemailConnection?: Connection
  __moemailBoundConfig?: AppConfig
}

const dbGlobals = globalThis as DbGlobals

function connectionSignature(config: AppConfig, driver: DatabaseDriver) {
  return driver === "sqlite"
    ? JSON.stringify({ driver, path: config.database.sqlite.path })
    : JSON.stringify({ driver, ...config.database.postgres })
}

function configuredConnectionSignature(config: AppConfig) {
  return connectionSignature(config, config.database.driver)
}

/** 配置中的数据库类型与本进程绑定的类型是否一致；不一致时登记重启需求。 */
export function checkDriverBinding() {
  const bound = getBoundDriver()
  const configured = getConfiguredDriver()
  if (configured !== bound) {
    markRestartRequired(`数据库类型由 ${bound} 改为 ${configured}，需要重启进程后生效`)
  }
  return { bound, configured, matches: bound === configured }
}

function openConnection(config: AppConfig, driver: DatabaseDriver): Connection {
  const signature = connectionSignature(config, driver)

  if (driver === "postgres") {
    const pool = createPostgresPool(config)
    return {
      signature,
      driver: "postgres",
      pool,
      db: createPostgresDrizzle(pool) as unknown as AppDb,
    }
  }

  const { sqlite, databasePath } = openSqliteConnection(config)
  return {
    signature,
    driver: "sqlite",
    sqlite,
    databasePath,
    db: createSqliteDrizzle(sqlite),
  }
}

async function closeConnection(connection: Connection) {
  if (connection.pool) await connection.pool.end()
  if (connection.sqlite?.open) connection.sqlite.close()
}

function drainConnection(connection: Connection) {
  setTimeout(() => {
    void closeConnection(connection).catch(error => {
      console.error("Failed to close the previous database connection", error)
    })
  }, CONNECTION_DRAIN_MS).unref?.()
}

async function verifyOpenConnection(connection: Connection) {
  if (connection.sqlite) {
    connection.sqlite.prepare("SELECT 1").get()
    return
  }
  if (connection.pool) await connection.pool.query("SELECT 1")
}

export type DatabaseConfigPreparation =
  | {
    ok: true
    commit: () => void
    rollback: () => Promise<void>
    restartRequired?: boolean
  }
  | { ok: false; issues: ConfigIssue[] }

function migrationIssue(config: AppConfig, error: unknown): ConfigIssue[] {
  return [{
    path: config.database.driver === "sqlite"
      ? "database.sqlite.path"
      : "database.postgres.url",
    message: `数据库迁移或验证失败：${error instanceof Error ? error.message : String(error)}`,
  }]
}

export async function prepareDatabaseConfigChange(
  previous: AppConfig,
  next: AppConfig,
  options: { boundDriver?: DatabaseDriver } = {},
): Promise<DatabaseConfigPreparation> {
  const connectionChanged = configuredConnectionSignature(previous)
    !== configuredConnectionSignature(next)

  try {
    const {
      listEmperorCredentials,
      probeDatabase,
      runMigrations,
    } = await import("./database-setup")
    // Every completed runtime candidate must already contain one owner; a
    // connection switch must contain the same owner identity as the active DB.
    // Check this before migrations so an empty/wrong candidate is rejected
    // without mutating it merely because a config edit pointed at that target.
    // First-run staged setup=false is the sole path that intentionally creates
    // schema before creating the owner.
    if (next.setup.completed) {
      const candidateOwners = await listEmperorCredentials(next)
      if (candidateOwners.length !== 1) {
        return {
          ok: false,
          issues: [{
            path: next.database.driver === "sqlite"
              ? "database.sqlite.path"
              : "database.postgres.url",
            message: candidateOwners.length === 0
              ? "候选数据库没有站主账号，不能把 setup.completed 应用为 true"
              : "候选数据库存在多个站主账号，不能安全应用 setup.completed=true",
          }],
        }
      }

      if (previous.setup.completed && connectionChanged) {
        const currentOwners = await listEmperorCredentials(previous)
        const identity = (owners: typeof currentOwners) => JSON.stringify(
          owners.map(owner => ({
            userId: owner.userId,
            username: owner.username,
            passwordHash: owner.passwordHash,
          })),
        )

        if (currentOwners.length === 0) {
          return {
            ok: false,
            issues: [{
              path: "database",
              message: "当前数据库没有站主账号，无法安全验证数据库切换",
            }],
          }
        }
        if (identity(currentOwners) !== identity(candidateOwners)) {
          return {
            ok: false,
            issues: [{
              path: next.database.driver === "sqlite"
                ? "database.sqlite.path"
                : "database.postgres.url",
              message: "候选数据库的站主身份或密码记录与当前数据库不一致；请先完整迁移数据再切换",
            }],
          }
        }
      }
    }

    const issues = await probeDatabase(next)
    if (issues.length > 0) return { ok: false, issues }
    await runMigrations(next)
  } catch (error) {
    return { ok: false, issues: migrationIssue(next, error) }
  }

  // Cold-start validation cannot call getBoundDriver(): its fallback path reads
  // getConfig(), which intentionally rejects an unvalidated boot candidate.
  // The candidate driver is safe to use here only after probe/migration/owner
  // validation above has succeeded; callers do not mutate the global binding.
  const boundDriver = options.boundDriver ?? getBoundDriver()
  if (!connectionChanged) {
    return {
      ok: true,
      commit: () => undefined,
      rollback: async () => undefined,
      restartRequired: next.database.driver !== boundDriver,
    }
  }

  if (next.database.driver !== boundDriver) {
    return {
      ok: true,
      commit: () => {
        dbGlobals.__moemailBoundConfig = previous
      },
      rollback: async () => undefined,
      restartRequired: true,
    }
  }

  let candidate: Connection | undefined
  try {
    candidate = openConnection(next, boundDriver)
    await verifyOpenConnection(candidate)
  } catch (error) {
    if (candidate) await closeConnection(candidate).catch(() => undefined)
    return { ok: false, issues: migrationIssue(next, error) }
  }

  const preparedConnection = candidate

  let committed = false
  return {
    ok: true,
    commit: () => {
      const existing = dbGlobals.__moemailConnection
      dbGlobals.__moemailConnection = preparedConnection
      dbGlobals.__moemailBoundConfig = next
      committed = true

      if (existing && existing !== preparedConnection) drainConnection(existing)
      console.log(JSON.stringify({
        event: "database.reconnected",
        driver: preparedConnection.driver,
        target: preparedConnection.databasePath ?? "postgres",
      }))
    },
    rollback: async () => {
      if (!committed) await closeConnection(preparedConnection)
    },
    restartRequired: false,
  }
}

function ensureConnection(): Connection {
  const config = getConfig()
  const existing = dbGlobals.__moemailConnection
  const binding = checkDriverBinding()
  const effectiveConfig = binding.matches
    ? config
    : dbGlobals.__moemailBoundConfig ?? config

  if (existing && !binding.matches) return existing

  const signature = connectionSignature(effectiveConfig, binding.bound)
  if (existing?.signature === signature) return existing

  const connection = openConnection(effectiveConfig, binding.bound)
  dbGlobals.__moemailConnection = connection
  dbGlobals.__moemailBoundConfig = effectiveConfig

  if (existing) {
    console.log(JSON.stringify({
      event: "database.reconnected",
      driver: connection.driver,
      target: connection.databasePath ?? "postgres",
    }))
    drainConnection(existing)
  }

  return connection
}

export const createDb = () => ensureConnection().db
export const getDatabaseDriver = () => getBoundDriver()

export function getSqlite() {
  const connection = ensureConnection()
  if (!connection.sqlite) {
    throw new Error("当前数据库类型为 postgres，无法获取 SQLite 句柄")
  }
  return connection.sqlite
}

export function getDatabasePath() {
  const connection = ensureConnection()
  if (!connection.databasePath) {
    throw new Error("当前数据库类型为 postgres，没有 SQLite 文件路径")
  }
  return connection.databasePath
}

export function getPostgresPool() {
  const connection = ensureConnection()
  if (!connection.pool) {
    throw new Error("当前数据库类型为 sqlite，无法获取 PostgreSQL 连接池")
  }
  return connection.pool
}

export async function closeDatabase() {
  const connection = dbGlobals.__moemailConnection
  if (!connection) return

  dbGlobals.__moemailConnection = undefined
  await closeConnection(connection)
}

export type Db = ReturnType<typeof createDb>
