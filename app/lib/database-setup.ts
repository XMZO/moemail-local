import { randomUUID } from "node:crypto"
import Database from "better-sqlite3"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator"
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres"
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator"
import { resolve } from "node:path"
import type { ConfigIssue } from "./config/schema"
import type { AppConfig } from "./config/schema"
import { createPostgresPool, openSqliteConnection, resolveSqlitePath } from "./db"
import { ROLES } from "./permissions"

/**
 * 初始化向导使用的数据库操作。这里全部显式指定 driver，
 * 不经过随进程绑定的 schema facade，因此可以在切换数据库类型时正确工作。
 */

const SQLITE_MIGRATIONS = "drizzle-local"
const POSTGRES_MIGRATIONS = "drizzle-postgres"
const EMPEROR_DESCRIPTION = "皇帝（网站所有者）"

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function probeDatabase(config: AppConfig): Promise<ConfigIssue[]> {
  const { driver } = config.database
  try {
    if (driver === "sqlite") {
      const { sqlite } = openSqliteConnection(config)
      try {
        sqlite.prepare("SELECT 1").get()
      } finally {
        sqlite.close()
      }
      return []
    }

    const pool = createPostgresPool(config)
    try {
      await pool.query("SELECT 1")
    } finally {
      await pool.end()
    }
    return []
  } catch (error) {
    return [{
      path: driver === "sqlite" ? "database.sqlite.path" : "database.postgres.url",
      message: `无法连接数据库：${describe(error)}`,
    }]
  }
}

export async function runMigrations(config: AppConfig) {
  if (config.database.driver === "sqlite") {
    const { sqlite } = openSqliteConnection(config)
    const foreignKeysEnabled = sqlite.pragma("foreign_keys", { simple: true }) === 1
    try {
      sqlite.pragma("foreign_keys = OFF")
      migrateSqlite(drizzleSqlite(sqlite), {
        migrationsFolder: resolve(process.cwd(), SQLITE_MIGRATIONS),
      })
      sqlite.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`)

      const violations = sqlite.pragma("foreign_key_check") as unknown[]
      if (violations.length > 0) {
        throw new Error(`SQLite 外键校验失败: ${JSON.stringify(violations)}`)
      }
    } finally {
      sqlite.close()
    }
    return
  }

  const pool = createPostgresPool(config)
  const client = await pool.connect()
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('moemail:migrate'))")
    try {
      await migratePostgres(drizzlePostgres(client), {
        migrationsFolder: resolve(process.cwd(), POSTGRES_MIGRATIONS),
      })
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('moemail:migrate'))")
    }
  } finally {
    client.release()
    await pool.end()
  }
}

export interface InitialAdmin {
  username: string
  passwordHash: string
}

export interface EmperorCredential {
  userId: string
  username: string | null
  passwordHash: string | null
}

/**
 * 显式从候选数据库读取站主身份，不经过当前进程绑定的 schema facade。
 * 初始化断点续跑和数据库切换连续性校验都依赖这份证据。
 */
export async function listEmperorCredentials(
  config: AppConfig,
): Promise<EmperorCredential[]> {
  if (config.database.driver === "sqlite") {
    // Runtime candidate validation must not create an empty file or switch it
    // to WAL merely by inspecting a path that will later be rejected.
    const sqlite = new Database(resolveSqlitePath(config), {
      readonly: true,
      fileMustExist: true,
    })
    try {
      return sqlite.prepare(`
        SELECT
          user.id AS userId,
          user.username AS username,
          user.password AS passwordHash
        FROM user_role
        INNER JOIN role ON role.id = user_role.role_id
        INNER JOIN user ON user.id = user_role.user_id
        WHERE role.name = ?
        ORDER BY user.id
      `).all(ROLES.EMPEROR) as EmperorCredential[]
    } finally {
      sqlite.close()
    }
  }

  const pool = createPostgresPool(config)
  try {
    const result = await pool.query<{
      userId: string
      username: string | null
      passwordHash: string | null
    }>(`
      SELECT
        "user".id AS "userId",
        "user".username AS username,
        "user".password AS "passwordHash"
      FROM user_role
      INNER JOIN "role" ON "role".id = user_role.role_id
      INNER JOIN "user" ON "user".id = user_role.user_id
      WHERE "role".name = $1
      ORDER BY "user".id
    `, [ROLES.EMPEROR])
    return result.rows
  } finally {
    await pool.end()
  }
}

export type AdminCreationResult = "created" | "emperor_exists" | "username_taken"

function createEmperorSqlite(config: AppConfig, admin: InitialAdmin): AdminCreationResult {
  const { sqlite } = openSqliteConnection(config)
  try {
    const run = sqlite.transaction((): AdminCreationResult => {
      const existingEmperor = sqlite.prepare(`
        SELECT user_role.user_id AS userId
        FROM user_role
        INNER JOIN role ON role.id = user_role.role_id
        WHERE role.name = ?
        LIMIT 1
      `).get(ROLES.EMPEROR)
      if (existingEmperor) return "emperor_exists"

      const existingUser = sqlite
        .prepare("SELECT id FROM user WHERE username = ?")
        .get(admin.username)
      if (existingUser) return "username_taken"

      const now = Math.floor(Date.now() / 1_000)
      const userId = randomUUID()
      sqlite.prepare(`
        INSERT INTO user (id, name, username, password)
        VALUES (?, ?, ?, ?)
      `).run(userId, admin.username, admin.username, admin.passwordHash)

      const existingRole = sqlite
        .prepare("SELECT id FROM role WHERE name = ? ORDER BY created_at, id LIMIT 1")
        .get(ROLES.EMPEROR) as { id: string } | undefined
      const roleId = existingRole?.id ?? randomUUID()
      if (!existingRole) {
        sqlite.prepare(`
          INSERT INTO role (id, name, description, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(roleId, ROLES.EMPEROR, EMPEROR_DESCRIPTION, now, now)
      }

      sqlite.prepare(`
        INSERT INTO user_role (user_id, role_id, created_at)
        VALUES (?, ?, ?)
      `).run(userId, roleId, now)

      return "created"
    })

    return run.immediate()
  } finally {
    sqlite.close()
  }
}

async function createEmperorPostgres(
  config: AppConfig,
  admin: InitialAdmin,
): Promise<AdminCreationResult> {
  const pool = createPostgresPool(config)
  const client = await pool.connect()
  let started = false
  try {
    await client.query("BEGIN")
    started = true
    await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:init-emperor'))")

    const existingEmperor = await client.query(`
      SELECT user_role.user_id
      FROM user_role
      INNER JOIN "role" ON "role".id = user_role.role_id
      WHERE "role".name = $1
      LIMIT 1
    `, [ROLES.EMPEROR])
    if (existingEmperor.rows.length > 0) {
      await client.query("ROLLBACK")
      started = false
      return "emperor_exists"
    }

    const existingUser = await client.query(
      `SELECT id FROM "user" WHERE username = $1`,
      [admin.username],
    )
    if (existingUser.rows.length > 0) {
      await client.query("ROLLBACK")
      started = false
      return "username_taken"
    }

    const userId = randomUUID()
    await client.query(
      `INSERT INTO "user" (id, name, username, password) VALUES ($1, $2, $3, $4)`,
      [userId, admin.username, admin.username, admin.passwordHash],
    )

    const existingRole = await client.query<{ id: string }>(
      `SELECT id FROM "role" WHERE name = $1 ORDER BY created_at NULLS LAST, id LIMIT 1`,
      [ROLES.EMPEROR],
    )
    const roleId = existingRole.rows[0]?.id ?? randomUUID()
    if (existingRole.rows.length === 0) {
      await client.query(`
        INSERT INTO "role" (id, name, description, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
      `, [roleId, ROLES.EMPEROR, EMPEROR_DESCRIPTION])
    }

    await client.query(
      `INSERT INTO user_role (user_id, role_id, created_at) VALUES ($1, $2, NOW())`,
      [userId, roleId],
    )

    await client.query("COMMIT")
    started = false
    return "created"
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

export function createInitialEmperor(config: AppConfig, admin: InitialAdmin) {
  return config.database.driver === "postgres"
    ? createEmperorPostgres(config, admin)
    : Promise.resolve(createEmperorSqlite(config, admin))
}
