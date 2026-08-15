import { eq } from "drizzle-orm"
import { createDb, getDatabaseDriver, getPostgresPool, getSqlite } from "./db"
import { users } from "./schema"

export type UserStatusMutationResult =
  | "banned"
  | "unbanned"
  | "not_found"
  | "emperor_immutable"
  | "state_conflict"

/**
 * Reads the live status instead of trusting a JWT snapshot. This makes a ban
 * effective for already-open sessions and API keys on their next request.
 */
export async function isUserBanned(userId: string) {
  const row = await createDb()
    .select({ bannedAt: users.bannedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row.length > 0 ? row[0].bannedAt !== null : null
}

/**
 * Changes the account status while holding the same user/Emperor locks used
 * by role promotion and deletion. An Emperor's status is immutable through
 * the web/API surface, even if a stale client races with a role change.
 */
export async function setUserBannedAtomically(
  userId: string,
  banned: boolean,
  expectedBanned?: boolean,
): Promise<UserStatusMutationResult> {
  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction(() => {
      const target = getSqlite().prepare(
        "SELECT id, banned_at FROM user WHERE id = ? LIMIT 1",
      ).get(userId)
      if (!target) return "not_found"
      if (
        expectedBanned !== undefined
        && Boolean((target as { banned_at?: number | null }).banned_at) !== expectedBanned
      ) return "state_conflict"

      const emperor = getSqlite().prepare(`
        SELECT 1
        FROM user_role
        INNER JOIN role ON role.id = user_role.role_id
        WHERE user_role.user_id = ? AND role.name = 'emperor'
        LIMIT 1
      `).get(userId)
      if (emperor) return "emperor_immutable"

      getSqlite().prepare(
        "UPDATE user SET banned_at = ? WHERE id = ?",
      ).run(banned ? Date.now() : null, userId)
      return banned ? "banned" : "unbanned"
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
    const target = await client.query<{ id: string; banned_at: Date | null }>(
      'SELECT id, "banned_at" FROM "user" WHERE id = $1 FOR UPDATE',
      [userId],
    )
    if (target.rowCount !== 1) {
      await client.query("COMMIT")
      return "not_found"
    }
    if (
      expectedBanned !== undefined
      && Boolean(target.rows[0].banned_at) !== expectedBanned
    ) {
      await client.query("COMMIT")
      return "state_conflict"
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

    await client.query(
      'UPDATE "user" SET "banned_at" = $1 WHERE id = $2',
      [banned ? new Date() : null, userId],
    )
    await client.query("COMMIT")
    return banned ? "banned" : "unbanned"
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
