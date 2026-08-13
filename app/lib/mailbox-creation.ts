import { nanoid } from "nanoid"
import { getDatabaseDriver, getPostgresPool, getSqlite } from "./db"
import { mailboxBlockAllowedRoles, mailboxUserBlockScope } from "./mailbox-block-scope"
import { ROLES, type Role } from "./permissions"

export type MailboxCreationFailure =
  | "MAILBOX_QUOTA_EXCEEDED"
  | "MAILBOX_NAME_BLOCKED"
  | "MAILBOX_ADDRESS_CONFLICT"
  | "MAILBOX_CREATE_FAILED"

export type MailboxCreationResult =
  | { ok: true; id: string; address: string }
  | { ok: false; code: MailboxCreationFailure }

export interface MailboxCreationInput {
  userId: string
  /** Null requests a collision-resistant random local part. */
  localPart: string | null
  domain: string
  expiresAt: Date
  /** Zero means unlimited. */
  maxActiveMailboxes: number
}

const RANDOM_ATTEMPTS = 32

function randomLocalPart() {
  return nanoid(8).toLowerCase()
}

function mailboxBlockApplies(scopeKey: string, userId: string, roles: Role[]) {
  if (scopeKey === "global" || scopeKey === mailboxUserBlockScope(userId)) return true
  const allowedRoles = mailboxBlockAllowedRoles(scopeKey)
  return allowedRoles !== null
    && !roles.includes(ROLES.EMPEROR)
    && !allowedRoles.some(role => roles.includes(role))
}

function sqliteCreateMailbox(input: MailboxCreationInput): MailboxCreationResult {
  const sqlite = getSqlite()
  return sqlite.transaction((): MailboxCreationResult => {
    const now = Date.now()
    if (input.maxActiveMailboxes > 0) {
      const row = sqlite.prepare(`
        SELECT COUNT(*) AS count FROM email
        WHERE userId = ? AND expires_at > ?
      `).get(input.userId, now) as { count: number }
      if (Number(row.count) >= input.maxActiveMailboxes) {
        return { ok: false, code: "MAILBOX_QUOTA_EXCEEDED" }
      }
    }

    const attempts = input.localPart ? 1 : RANDOM_ATTEMPTS
    const roleRows = sqlite.prepare(`
      SELECT role.name AS name FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE user_role.user_id = ?
    `).all(input.userId) as Array<{ name: string }>
    const roleNames = roleRows.map(row => row.name as Role)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const localPart = input.localPart ?? randomLocalPart()
      const address = `${localPart}@${input.domain}`
      const blocks = sqlite.prepare(`
        SELECT scope_key AS scopeKey FROM mailbox_name_block
        WHERE local_part = ? AND domain = ?
      `).all(localPart, input.domain) as Array<{ scopeKey: string }>
      if (blocks.some(block => mailboxBlockApplies(block.scopeKey, input.userId, roleNames))) {
        if (input.localPart) return { ok: false, code: "MAILBOX_NAME_BLOCKED" }
        continue
      }
      const existing = sqlite.prepare(`
        SELECT 1 FROM email WHERE LOWER(address) = ? LIMIT 1
      `).get(address)
      if (existing) {
        if (input.localPart) return { ok: false, code: "MAILBOX_ADDRESS_CONFLICT" }
        continue
      }

      const id = crypto.randomUUID()
      sqlite.prepare(`
        INSERT INTO email (id, address, userId, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, address, input.userId, now, input.expiresAt.getTime())
      return { ok: true, id, address }
    }
    return { ok: false, code: "MAILBOX_CREATE_FAILED" }
  }).immediate()
}

async function postgresCreateMailbox(input: MailboxCreationInput): Promise<MailboxCreationResult> {
  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    // Global blocks take an exclusive lock on this key. Mailbox creation and
    // user-scoped blocks take the shared key first, then the per-user key.
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
      ["moemail:mailbox-block:global"],
    )
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`moemail:mailbox-create:${input.userId}`],
    )

    if (input.maxActiveMailboxes > 0) {
      const count = await client.query<{ count: string }>(`
        SELECT COUNT(*) AS count FROM email
        WHERE "userId" = $1 AND expires_at > NOW()
      `, [input.userId])
      if (Number(count.rows[0]?.count ?? 0) >= input.maxActiveMailboxes) {
        await client.query("ROLLBACK")
        return { ok: false, code: "MAILBOX_QUOTA_EXCEEDED" }
      }
    }

    const attempts = input.localPart ? 1 : RANDOM_ATTEMPTS
    const rolesResult = await client.query<{ name: string }>(`
      SELECT role.name FROM user_role
      INNER JOIN role ON role.id = user_role.role_id
      WHERE user_role.user_id = $1
    `, [input.userId])
    const roleNames = rolesResult.rows.map(row => row.name as Role)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const localPart = input.localPart ?? randomLocalPart()
      const address = `${localPart}@${input.domain}`
      const blocks = await client.query<{ scopeKey: string }>(`
        SELECT scope_key AS "scopeKey" FROM mailbox_name_block
        WHERE local_part = $1 AND domain = $2
      `, [localPart, input.domain])
      if (blocks.rows.some(block => mailboxBlockApplies(block.scopeKey, input.userId, roleNames))) {
        if (input.localPart) {
          await client.query("ROLLBACK")
          return { ok: false, code: "MAILBOX_NAME_BLOCKED" }
        }
        continue
      }

      const id = crypto.randomUUID()
      const inserted = await client.query<{ id: string; address: string }>(`
        INSERT INTO email (id, address, "userId", created_at, expires_at)
        VALUES ($1, $2, $3, NOW(), $4)
        ON CONFLICT DO NOTHING
        RETURNING id, address
      `, [id, address, input.userId, input.expiresAt])
      if (inserted.rowCount === 1) {
        await client.query("COMMIT")
        return { ok: true, id: inserted.rows[0].id, address: inserted.rows[0].address }
      }
      if (input.localPart) {
        await client.query("ROLLBACK")
        return { ok: false, code: "MAILBOX_ADDRESS_CONFLICT" }
      }
    }

    await client.query("ROLLBACK")
    return { ok: false, code: "MAILBOX_CREATE_FAILED" }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export function createMailbox(input: MailboxCreationInput) {
  return getDatabaseDriver() === "sqlite"
    ? Promise.resolve(sqliteCreateMailbox(input))
    : postgresCreateMailbox(input)
}
