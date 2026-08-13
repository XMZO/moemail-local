import { removeUserAccessOverrideFromDocument } from "./access-policies"
import { CONFIG_KEYS } from "./config-store"
import { getDatabaseDriver, getPostgresPool, getSqlite } from "./db"

export type DeleteUserResult = "deleted" | "not_found" | "emperor_immutable"

/**
 * Deletes the user, non-cascading API keys, and their policy override as one
 * database unit. The Emperor and per-user role locks use the same order as
 * role assignment/claim, so a concurrent promotion cannot pass a stale check.
 */
export async function deleteUserAtomically(userId: string): Promise<DeleteUserResult> {
  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction(() => {
      const target = getSqlite().prepare(`SELECT id FROM user WHERE id = ? LIMIT 1`).get(userId)
      if (!target) return "not_found"
      const emperor = getSqlite().prepare(`
        SELECT 1
        FROM user_role
        INNER JOIN role ON role.id = user_role.role_id
        WHERE user_role.user_id = ? AND role.name = 'emperor'
        LIMIT 1
      `).get(userId)
      if (emperor) return "emperor_immutable"

      getSqlite().prepare(`DELETE FROM api_keys WHERE user_id = ?`).run(userId)
      getSqlite().prepare(`DELETE FROM user WHERE id = ?`).run(userId)

      const stored = getSqlite().prepare(`
        SELECT value FROM site_config WHERE key = ? LIMIT 1
      `).get(CONFIG_KEYS.ACCESS_POLICIES) as { value?: string } | undefined
      const next = removeUserAccessOverrideFromDocument(stored?.value, userId)
      if (next !== null && next !== stored?.value) {
        getSqlite().prepare(`
          UPDATE site_config SET value = ?, updated_at = ? WHERE key = ?
        `).run(next, Date.now(), CONFIG_KEYS.ACCESS_POLICIES)
      }
      return "deleted"
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:init-emperor'))")
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`moemail:user-role:${userId}`],
    )
    const target = await client.query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [userId])
    if (target.rowCount !== 1) {
      await client.query("COMMIT")
      return "not_found"
    }
    const emperor = await client.query(`
      SELECT 1
      FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE user_role.user_id = $1 AND role.name = 'emperor'
      LIMIT 1
    `, [userId])
    if (emperor.rowCount) {
      await client.query("COMMIT")
      return "emperor_immutable"
    }

    await client.query(`DELETE FROM api_keys WHERE user_id = $1`, [userId])
    await client.query(`DELETE FROM "user" WHERE id = $1`, [userId])
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["moemail:access-policies"],
    )
    const stored = await client.query<{ value: string }>(
      `SELECT value FROM site_config WHERE key = $1 FOR UPDATE`,
      [CONFIG_KEYS.ACCESS_POLICIES],
    )
    const current = stored.rows[0]?.value
    const next = removeUserAccessOverrideFromDocument(current, userId)
    if (next !== null && next !== current) {
      await client.query(`
        UPDATE site_config SET value = $1, updated_at = NOW() WHERE key = $2
      `, [next, CONFIG_KEYS.ACCESS_POLICIES])
    }
    await client.query("COMMIT")
    return "deleted"
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
