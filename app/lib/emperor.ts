import { randomUUID } from "node:crypto"
import {
  getDatabaseDriver,
  getPostgresPool,
  getSqlite,
} from "./db"
import { ROLES } from "./permissions"

export type EmperorClaimResult =
  | "claimed"
  | "already_emperor"
  | "emperor_exists"

interface EmperorAssignment {
  userId: string
}

function claimSqlite(userId: string): EmperorClaimResult {
  const sqlite = getSqlite()
  const claim = sqlite.transaction((): EmperorClaimResult => {
    const assignments = sqlite.prepare(`
      SELECT user_role.user_id AS userId
      FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE role.name = ?
      ORDER BY user_role.user_id
    `).all(ROLES.EMPEROR) as EmperorAssignment[]

    if (assignments.length > 0) {
      return assignments.some(assignment => assignment.userId === userId)
        ? "already_emperor"
        : "emperor_exists"
    }

    const existingRole = sqlite.prepare(`
      SELECT id
      FROM role
      WHERE name = ?
      ORDER BY created_at, id
      LIMIT 1
    `).get(ROLES.EMPEROR) as { id: string } | undefined
    const roleId = existingRole?.id ?? randomUUID()
    const now = Math.floor(Date.now() / 1_000)

    if (!existingRole) {
      sqlite.prepare(`
        INSERT INTO role (id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(roleId, ROLES.EMPEROR, null, now, now)
    }

    sqlite.prepare("DELETE FROM user_role WHERE user_id = ?").run(userId)
    sqlite.prepare(`
      INSERT INTO user_role (user_id, role_id, created_at)
      VALUES (?, ?, ?)
    `).run(userId, roleId, now)

    return "claimed"
  })

  return claim.immediate()
}

async function claimPostgres(userId: string): Promise<EmperorClaimResult> {
  const client = await getPostgresPool().connect()
  let transactionStarted = false

  try {
    await client.query("BEGIN")
    transactionStarted = true
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('moemail:init-emperor'))",
    )

    const assignments = await client.query<EmperorAssignment>(`
      SELECT user_role.user_id AS "userId"
      FROM user_role
      INNER JOIN "role" ON "role".id = user_role.role_id
      WHERE "role".name = $1
      ORDER BY user_role.user_id
    `, [ROLES.EMPEROR])

    let result: EmperorClaimResult
    if (assignments.rows.length > 0) {
      result = assignments.rows.some(assignment => assignment.userId === userId)
        ? "already_emperor"
        : "emperor_exists"
    } else {
      const existingRole = await client.query<{ id: string }>(`
        SELECT id
        FROM "role"
        WHERE name = $1
        ORDER BY created_at NULLS LAST, id
        LIMIT 1
      `, [ROLES.EMPEROR])
      const roleId = existingRole.rows[0]?.id ?? randomUUID()

      if (existingRole.rows.length === 0) {
        await client.query(`
          INSERT INTO "role" (id, name, description, created_at, updated_at)
          VALUES ($1, $2, $3, NOW(), NOW())
        `, [roleId, ROLES.EMPEROR, null])
      }

      await client.query("DELETE FROM user_role WHERE user_id = $1", [userId])
      await client.query(`
        INSERT INTO user_role (user_id, role_id, created_at)
        VALUES ($1, $2, NOW())
      `, [userId, roleId])
      result = "claimed"
    }

    await client.query("COMMIT")
    transactionStarted = false
    return result
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => undefined)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function claimEmperor(userId: string) {
  return getDatabaseDriver() === "postgres"
    ? claimPostgres(userId)
    : claimSqlite(userId)
}
