import { randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { getConfig } from "../../app/lib/config/runtime"
import { getDatabasePath, getSqlite } from "../../app/lib/db"

function acquireLock(lockPath: string, staleAfterMs: number) {
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600)
      try {
        writeFileSync(descriptor, JSON.stringify({ token, startedAt: new Date().toISOString() }))
      } catch (error) {
        closeSync(descriptor)
        if (existsSync(lockPath)) {
          unlinkSync(lockPath)
        }
        throw error
      }
      return { descriptor, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error
      }

      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { startedAt?: string }
        const startedAt = Date.parse(lock.startedAt || "")
        if (!Number.isFinite(startedAt) || Date.now() - startedAt < staleAfterMs) {
          return null
        }
      } catch {
        return null
      }

      unlinkSync(lockPath)
    }
  }

  return null
}

const databasePath = getDatabasePath()
if (databasePath === ":memory:") {
  throw new Error("Cleanup requires a file-backed SQLite database")
}

const cleanupConfig = getConfig().cleanup
const batchSize = cleanupConfig.batchSize
const maxRows = cleanupConfig.maxRows
const permanentRetentionDays = cleanupConfig.permanentMessageRetentionDays
const lockStaleMinutes = cleanupConfig.lockStaleMinutes
const lockPath = `${databasePath}.cleanup.lock`
const lock = acquireLock(lockPath, lockStaleMinutes * 60_000)

if (lock === null) {
  console.log(JSON.stringify({ event: "cleanup.skipped", reason: "already_running" }))
  process.exit(0)
}

try {
  const sqlite = getSqlite()
  const now = Date.now()
  const deletedRows = {
    deletedMessageShares: 0,
    deletedEmailShares: 0,
    deletedMessages: 0,
    deletedEmails: 0,
  }
  type DeletedCounter = keyof typeof deletedRows
  let batches = 0

  const totalDeleted = () => Object.values(deletedRows).reduce((total, count) => total + count, 0)
  const drainPhase = (
    counter: DeletedCounter,
    deleteBatch: (limit: number) => number,
  ) => {
    while (totalDeleted() < maxRows) {
      const limit = Math.min(batchSize, maxRows - totalDeleted())
      const deleted = deleteBatch(limit)
      if (deleted === 0) break
      if (deleted > limit) {
        throw new Error(`Cleanup phase ${counter} deleted ${deleted} rows with limit ${limit}`)
      }
      deletedRows[counter] += deleted
      batches += 1
    }
  }

  const deleteExpiredMessageShares = sqlite.transaction((limit: number) => (
    sqlite.prepare(`
      DELETE FROM message_share
      WHERE id IN (
        SELECT message_share.id
        FROM message_share
        INNER JOIN message ON message.id = message_share.message_id
        INNER JOIN email ON email.id = message."emailId"
        WHERE email.expires_at < ?
        ORDER BY email.expires_at, email.id, message.received_at, message.id, message_share.id
        LIMIT ?
      )
    `).run(now, limit).changes
  ))
  const deleteExpiredMessages = sqlite.transaction((limit: number) => (
    sqlite.prepare(`
      DELETE FROM message
      WHERE id IN (
        SELECT message.id
        FROM message
        INNER JOIN email ON email.id = message."emailId"
        WHERE email.expires_at < ?
          AND NOT EXISTS (
            SELECT 1
            FROM message_share
            WHERE message_share.message_id = message.id
          )
        ORDER BY email.expires_at, email.id, message.received_at, message.id
        LIMIT ?
      )
        AND NOT EXISTS (
          SELECT 1
          FROM message_share
          WHERE message_share.message_id = message.id
        )
    `).run(now, limit).changes
  ))
  const deleteExpiredEmailShares = sqlite.transaction((limit: number) => (
    sqlite.prepare(`
      DELETE FROM email_share
      WHERE id IN (
        SELECT email_share.id
        FROM email_share
        INNER JOIN email ON email.id = email_share.email_id
        WHERE email.expires_at < ?
        ORDER BY email.expires_at, email.id, email_share.id
        LIMIT ?
      )
    `).run(now, limit).changes
  ))
  const deleteExpiredEmails = sqlite.transaction((limit: number) => (
    sqlite.prepare(`
      DELETE FROM email
      WHERE id IN (
        SELECT email.id
        FROM email
        WHERE email.expires_at < ?
          AND NOT EXISTS (
            SELECT 1
            FROM message
            WHERE message."emailId" = email.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM email_share
            WHERE email_share.email_id = email.id
          )
        ORDER BY email.expires_at, email.id
        LIMIT ?
      )
        AND expires_at < ?
        AND NOT EXISTS (
          SELECT 1
          FROM message
          WHERE message."emailId" = email.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM email_share
          WHERE email_share.email_id = email.id
        )
    `).run(now, limit, now).changes
  ))

  drainPhase("deletedMessageShares", deleteExpiredMessageShares)
  drainPhase("deletedMessages", deleteExpiredMessages)
  drainPhase("deletedEmailShares", deleteExpiredEmailShares)
  drainPhase("deletedEmails", deleteExpiredEmails)

  if (permanentRetentionDays > 0 && totalDeleted() < maxRows) {
    const retentionCutoff = now - permanentRetentionDays * 86_400_000
    const permanentMailboxThreshold = Date.parse("9000-01-01T00:00:00.000Z")
    const deletePermanentMessageShares = sqlite.transaction((limit: number) => (
      sqlite.prepare(`
        DELETE FROM message_share
        WHERE id IN (
          SELECT message_share.id
          FROM message_share
          INNER JOIN message ON message.id = message_share.message_id
          INNER JOIN email ON email.id = message."emailId"
          WHERE email.expires_at >= ?
            AND message.received_at < ?
          ORDER BY message.received_at, message.id, message_share.id
          LIMIT ?
        )
      `).run(permanentMailboxThreshold, retentionCutoff, limit).changes
    ))
    const deletePermanentMessages = sqlite.transaction((limit: number) => (
      sqlite.prepare(`
        DELETE FROM message
        WHERE id IN (
          SELECT message.id
          FROM message
          INNER JOIN email ON email.id = message."emailId"
          WHERE email.expires_at >= ?
            AND message.received_at < ?
            AND NOT EXISTS (
              SELECT 1
              FROM message_share
              WHERE message_share.message_id = message.id
            )
          ORDER BY message.received_at, message.id
          LIMIT ?
        )
          AND NOT EXISTS (
            SELECT 1
            FROM message_share
            WHERE message_share.message_id = message.id
          )
      `).run(permanentMailboxThreshold, retentionCutoff, limit).changes
    ))

    drainPhase("deletedMessageShares", deletePermanentMessageShares)
    drainPhase("deletedMessages", deletePermanentMessages)
  }

  const deleted = totalDeleted()

  console.log(JSON.stringify({
    event: "cleanup.ok",
    databasePath,
    deleted,
    ...deletedRows,
    permanentRetentionDays,
    batches,
    capped: deleted === maxRows,
  }))
} finally {
  closeSync(lock.descriptor)
  if (existsSync(lockPath)) {
    try {
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string }
      if (current.token === lock.token) unlinkSync(lockPath)
    } catch {}
  }
}
