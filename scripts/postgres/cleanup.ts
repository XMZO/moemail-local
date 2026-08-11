import {
  closeDatabase,
  getDatabaseDriver,
  getPostgresPool,
} from "../../app/lib/db"
import { getConfig } from "../../app/lib/config/runtime"

if (getDatabaseDriver() !== "postgres") {
  throw new Error("请先在 data/config.yaml 中选择 PostgreSQL")
}

const cleanupConfig = getConfig().cleanup
const batchSize = cleanupConfig.batchSize
const maxRows = cleanupConfig.maxRows
const permanentRetentionDays = cleanupConfig.permanentMessageRetentionDays
const pool = getPostgresPool()
const client = await pool.connect()
let acquired = false

try {
  const lockResult = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('moemail:cleanup')) AS acquired",
  )
  acquired = lockResult.rows[0].acquired
  if (!acquired) {
    console.log(JSON.stringify({ event: "cleanup.skipped", reason: "already_running" }))
  } else {
    const now = new Date()
    const deletedRows = {
      deletedMessageShares: 0,
      deletedEmailShares: 0,
      deletedMessages: 0,
      deletedEmails: 0,
    }
    type DeletedCounter = keyof typeof deletedRows
    let batches = 0

    const totalDeleted = () => Object.values(deletedRows).reduce((total, count) => total + count, 0)
    const drainPhase = async (
      counter: DeletedCounter,
      deleteBatch: (limit: number) => Promise<number>,
    ) => {
      while (totalDeleted() < maxRows) {
        const limit = Math.min(batchSize, maxRows - totalDeleted())
        const deleted = await deleteBatch(limit)
        if (deleted === 0) break
        if (deleted > limit) {
          throw new Error(`Cleanup phase ${counter} deleted ${deleted} rows with limit ${limit}`)
        }
        deletedRows[counter] += deleted
        batches += 1
      }
    }

    await drainPhase("deletedMessageShares", async limit => {
      const result = await client.query(`
        WITH candidates AS (
          SELECT message_share.id
          FROM message_share
          INNER JOIN message ON message.id = message_share.message_id
          INNER JOIN email ON email.id = message."emailId"
          WHERE email.expires_at < $1
          ORDER BY email.expires_at, email.id, message.received_at, message.id, message_share.id
          LIMIT $2
          FOR UPDATE OF message_share SKIP LOCKED
        )
        DELETE FROM message_share
        USING candidates
        WHERE message_share.id = candidates.id
        RETURNING message_share.id
      `, [now, limit])
      return result.rowCount ?? 0
    })

    await drainPhase("deletedMessages", async limit => {
      const result = await client.query(`
        WITH candidates AS (
          SELECT message.id
          FROM message
          INNER JOIN email ON email.id = message."emailId"
          WHERE email.expires_at < $1
            AND NOT EXISTS (
              SELECT 1
              FROM message_share
              WHERE message_share.message_id = message.id
            )
          ORDER BY email.expires_at, email.id, message.received_at, message.id
          LIMIT $2
          FOR UPDATE OF message SKIP LOCKED
        )
        DELETE FROM message
        USING candidates
        WHERE message.id = candidates.id
          AND NOT EXISTS (
            SELECT 1
            FROM message_share
            WHERE message_share.message_id = message.id
          )
        RETURNING message.id
      `, [now, limit])
      return result.rowCount ?? 0
    })

    await drainPhase("deletedEmailShares", async limit => {
      const result = await client.query(`
        WITH candidates AS (
          SELECT email_share.id
          FROM email_share
          INNER JOIN email ON email.id = email_share.email_id
          WHERE email.expires_at < $1
          ORDER BY email.expires_at, email.id, email_share.id
          LIMIT $2
          FOR UPDATE OF email_share SKIP LOCKED
        )
        DELETE FROM email_share
        USING candidates
        WHERE email_share.id = candidates.id
        RETURNING email_share.id
      `, [now, limit])
      return result.rowCount ?? 0
    })

    await drainPhase("deletedEmails", async limit => {
      const result = await client.query(`
        WITH candidates AS (
          SELECT email.id
          FROM email
          WHERE email.expires_at < $1
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
          LIMIT $2
          FOR UPDATE OF email SKIP LOCKED
        )
        DELETE FROM email
        USING candidates
        WHERE email.id = candidates.id
          AND email.expires_at < $1
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
        RETURNING email.id
      `, [now, limit])
      return result.rowCount ?? 0
    })

    if (permanentRetentionDays > 0 && totalDeleted() < maxRows) {
      const retentionCutoff = new Date(now.getTime() - permanentRetentionDays * 86_400_000)
      const permanentMailboxThreshold = new Date("9000-01-01T00:00:00.000Z")

      await drainPhase("deletedMessageShares", async limit => {
        const result = await client.query(`
          WITH candidates AS (
            SELECT message_share.id
            FROM message_share
            INNER JOIN message ON message.id = message_share.message_id
            INNER JOIN email ON email.id = message."emailId"
            WHERE email.expires_at >= $1
              AND message.received_at < $2
            ORDER BY message.received_at, message.id, message_share.id
            LIMIT $3
            FOR UPDATE OF message_share SKIP LOCKED
          )
          DELETE FROM message_share
          USING candidates
          WHERE message_share.id = candidates.id
          RETURNING message_share.id
        `, [permanentMailboxThreshold, retentionCutoff, limit])
        return result.rowCount ?? 0
      })

      await drainPhase("deletedMessages", async limit => {
        const result = await client.query(`
          WITH candidates AS (
            SELECT message.id
            FROM message
            INNER JOIN email ON email.id = message."emailId"
            WHERE email.expires_at >= $1
              AND message.received_at < $2
              AND NOT EXISTS (
                SELECT 1
                FROM message_share
                WHERE message_share.message_id = message.id
              )
            ORDER BY message.received_at, message.id
            LIMIT $3
            FOR UPDATE OF message SKIP LOCKED
          )
          DELETE FROM message
          USING candidates
          WHERE message.id = candidates.id
            AND NOT EXISTS (
              SELECT 1
              FROM message_share
              WHERE message_share.message_id = message.id
            )
          RETURNING message.id
        `, [permanentMailboxThreshold, retentionCutoff, limit])
        return result.rowCount ?? 0
      })
    }

    const deleted = totalDeleted()
    console.log(JSON.stringify({
      event: "cleanup.ok",
      databaseDriver: "postgres",
      deleted,
      ...deletedRows,
      permanentRetentionDays,
      batches,
      capped: deleted === maxRows,
    }))
  }
} finally {
  if (acquired) {
    await client.query("SELECT pg_advisory_unlock(hashtext('moemail:cleanup'))")
  }
  client.release()
  await closeDatabase()
}
