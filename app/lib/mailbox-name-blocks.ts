import { eq } from "drizzle-orm"
import { createDb, getDatabaseDriver, getPostgresPool, getSqlite } from "./db"
import {
  normalizeMailboxDomain,
  normalizeMailboxLocalPart,
} from "./email-address"
import { mailboxNameBlocks } from "./schema"
import type { Role } from "./permissions"
import {
  ALL_MAILBOX_BLOCK_DOMAINS,
  GLOBAL_MAILBOX_BLOCK_SCOPE,
  RESERVABLE_MAILBOX_ROLES,
  mailboxBlockAllowedRoles,
  mailboxRoleBlockScope,
  mailboxUserBlockScope,
} from "./mailbox-block-scope"

export {
  ALL_MAILBOX_BLOCK_DOMAINS,
  GLOBAL_MAILBOX_BLOCK_SCOPE,
  mailboxBlockAllowedRoles,
} from "./mailbox-block-scope"

export type MailboxNameBlockScope = "global" | "user" | "roles"

export interface MailboxNameBlockInput {
  scope: MailboxNameBlockScope
  userId?: string | null
  allowedRoles?: Role[]
  localPart: string
  domain: string
}

function userScopeKey(userId: string) {
  return mailboxUserBlockScope(userId)
}

function normalizeInput(input: MailboxNameBlockInput) {
  const localPart = normalizeMailboxLocalPart(input.localPart)
  const domain = input.domain.trim() === ALL_MAILBOX_BLOCK_DOMAINS
    ? ALL_MAILBOX_BLOCK_DOMAINS
    : normalizeMailboxDomain(input.domain)
  if (!localPart || !domain) throw new Error("INVALID_MAILBOX_BLOCK_ADDRESS")
  const userId = input.scope === "user" && typeof input.userId === "string" && input.userId.length > 0
    ? input.userId
    : null
  if (input.scope === "user" && !userId) throw new Error("MAILBOX_BLOCK_USER_REQUIRED")
  const allowedRoles = input.scope === "roles"
    ? RESERVABLE_MAILBOX_ROLES.filter(role => input.allowedRoles?.includes(role))
    : []
  return {
    localPart,
    domain,
    userId,
    scopeKey: input.scope === "roles"
      ? mailboxRoleBlockScope(allowedRoles)
      : userId ? userScopeKey(userId) : GLOBAL_MAILBOX_BLOCK_SCOPE,
    allowedRoles,
  }
}

export async function listMailboxNameBlocks() {
  const blocks = await createDb().query.mailboxNameBlocks.findMany({
    with: { user: { columns: { id: true, name: true, username: true, email: true } } },
    orderBy: (block, { desc }) => [desc(block.createdAt), desc(block.id)],
  })
  return blocks.map(block => ({ ...block, allowedRoles: mailboxBlockAllowedRoles(block.scopeKey) }))
}

export async function createMailboxNameBlock(input: MailboxNameBlockInput) {
  const normalized = normalizeInput(input)
  const id = crypto.randomUUID()
  const createdAt = new Date()

  if (getDatabaseDriver() === "sqlite") {
    return getSqlite().transaction(() => {
      if (normalized.userId) {
        const target = getSqlite().prepare(`SELECT 1 FROM user WHERE id = ? LIMIT 1`)
          .get(normalized.userId)
        if (!target) throw new Error("USER_NOT_FOUND")
      }
      if (input.scope === "roles") {
        getSqlite().prepare(`
          DELETE FROM mailbox_name_block
          WHERE local_part = ? AND domain = ? AND scope_key LIKE 'roles:%'
        `).run(normalized.localPart, normalized.domain)
      }
      getSqlite().prepare(`
        INSERT OR IGNORE INTO mailbox_name_block
          (id, user_id, scope_key, local_part, domain, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        normalized.userId,
        normalized.scopeKey,
        normalized.localPart,
        normalized.domain,
        createdAt.getTime(),
      )
      return getSqlite().prepare(`
        SELECT
          id,
          user_id AS userId,
          scope_key AS scopeKey,
          local_part AS localPart,
          domain,
          created_at AS createdAt
        FROM mailbox_name_block
        WHERE scope_key = ? AND local_part = ? AND domain = ?
        LIMIT 1
      `).get(normalized.scopeKey, normalized.localPart, normalized.domain)
    }).immediate()
  }

  const client = await getPostgresPool().connect()
  try {
    await client.query("BEGIN")
    if (normalized.userId) {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
        ["moemail:mailbox-block:global"],
      )
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`moemail:mailbox-create:${normalized.userId}`],
      )
      const target = await client.query(
        `SELECT 1 FROM "user" WHERE id = $1 FOR KEY SHARE`,
        [normalized.userId],
      )
      if (!target.rowCount) throw new Error("USER_NOT_FOUND")
    } else {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["moemail:mailbox-block:global"],
      )
    }
    if (input.scope === "roles") {
      await client.query(`
        DELETE FROM mailbox_name_block
        WHERE local_part = $1 AND domain = $2 AND scope_key LIKE 'roles:%'
      `, [normalized.localPart, normalized.domain])
    }
    await client.query(`
      INSERT INTO mailbox_name_block
        (id, user_id, scope_key, local_part, domain, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (scope_key, local_part, domain) DO NOTHING
    `, [id, normalized.userId, normalized.scopeKey, normalized.localPart, normalized.domain, createdAt])
    const result = await client.query(`
      SELECT
        id,
        user_id AS "userId",
        scope_key AS "scopeKey",
        local_part AS "localPart",
        domain,
        created_at AS "createdAt"
      FROM mailbox_name_block
      WHERE scope_key = $1 AND local_part = $2 AND domain = $3
      LIMIT 1
    `, [normalized.scopeKey, normalized.localPart, normalized.domain])
    await client.query("COMMIT")
    return result.rows[0]
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function deleteMailboxNameBlock(id: string) {
  if (!id || id.length > 128) return false
  const deleted = await createDb().delete(mailboxNameBlocks)
    .where(eq(mailboxNameBlocks.id, id))
    .returning({ id: mailboxNameBlocks.id })
  return deleted.length === 1
}
