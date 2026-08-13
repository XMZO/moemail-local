import { and, eq, inArray } from "drizzle-orm"
import { createDb, getDatabaseDriver, getPostgresPool, getSqlite } from "./db"
import {
  normalizeMailboxAddress,
  normalizeMailboxDomain,
  normalizeMailboxLocalPart,
} from "./email-address"
import { mailboxNameBlocks } from "./schema"
import { mailboxUserBlockScope } from "./mailbox-creation"

export const GLOBAL_MAILBOX_BLOCK_SCOPE = "global"

export type MailboxNameBlockScope = "global" | "user"

export interface MailboxNameBlockInput {
  scope: MailboxNameBlockScope
  userId?: string | null
  localPart: string
  domain: string
}

function userScopeKey(userId: string) {
  return mailboxUserBlockScope(userId)
}

function normalizeInput(input: MailboxNameBlockInput) {
  const localPart = normalizeMailboxLocalPart(input.localPart)
  const domain = normalizeMailboxDomain(input.domain)
  if (!localPart || !domain) throw new Error("INVALID_MAILBOX_BLOCK_ADDRESS")
  const userId = input.scope === "user" && typeof input.userId === "string" && input.userId.length > 0
    ? input.userId
    : null
  if (input.scope === "user" && !userId) throw new Error("MAILBOX_BLOCK_USER_REQUIRED")
  return {
    localPart,
    domain,
    userId,
    scopeKey: userId ? userScopeKey(userId) : GLOBAL_MAILBOX_BLOCK_SCOPE,
  }
}

export async function findMailboxNameBlock(userId: string, addressValue: unknown) {
  const address = normalizeMailboxAddress(addressValue)
  if (!address) return null
  const separator = address.lastIndexOf("@")
  const [localPart, domain] = [address.slice(0, separator), address.slice(separator + 1)]
  return createDb().query.mailboxNameBlocks.findFirst({
    where: and(
      eq(mailboxNameBlocks.localPart, localPart),
      eq(mailboxNameBlocks.domain, domain),
      inArray(mailboxNameBlocks.scopeKey, [GLOBAL_MAILBOX_BLOCK_SCOPE, userScopeKey(userId)]),
    ),
  })
}

export async function listMailboxNameBlocks() {
  return createDb().query.mailboxNameBlocks.findMany({
    with: { user: { columns: { id: true, name: true, username: true, email: true } } },
    orderBy: (block, { desc }) => [desc(block.createdAt), desc(block.id)],
  })
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
