import { dirname, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { existsSync, unlinkSync } from "node:fs"
import { createPostgresPool } from "../../app/lib/db"
import {
  removeBackupAndConfigSnapshot,
  writeBackupConfigSnapshot,
} from "../ops/backup-config-snapshot"
import { backupConfigSnapshotPath } from "../ops/trusted-config"
import { createArchive } from "./archive"
import { verifyPostgres } from "./lib"
import { resolveLibpqSslMode } from "./libpq"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"
import { findPrunablePostgresBackups } from "./backup-retention"

process.umask(0o077)

const config = await requireValidatedRuntimeConfig("PostgreSQL backup")
if (config.database.driver !== "postgres") {
  throw new Error("请先在 data/config.yaml 中选择 PostgreSQL")
}

const timestamp = new Date().toISOString().replaceAll(":", "-")
const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`
const postgresConfig = config.database.postgres
const backupDirectory = postgresConfig.backupDir
const destination = resolve(
  process.cwd(),
  process.argv[2] || `${backupDirectory}/moemail-${timestamp}-${nonce}.dump`,
)
const configSnapshotDestination = backupConfigSnapshotPath(destination)

if (
  existsSync(destination)
  || existsSync(configSnapshotDestination)
) {
  throw new Error(`Backup destination already exists: ${destination}`)
}

let configSnapshot: string
let databaseCreated = false
try {
  const pool = createPostgresPool(config)
  try {
    const client = await pool.connect()
    let transactionOpen = false
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      transactionOpen = true
      const verification = await verifyPostgres(client)
      if (verification.securityInvariants.emperorUsers !== 1) {
        throw new Error("PostgreSQL backup must contain exactly one emperor user")
      }
      const snapshotResult = await client.query<{ snapshot: string }>(
        "SELECT pg_export_snapshot() AS snapshot",
      )
      const snapshot = snapshotResult.rows[0]?.snapshot
      if (!snapshot) throw new Error("PostgreSQL did not export a backup snapshot")
      await createArchive(destination, config, { snapshot })
      databaseCreated = true
      await client.query("COMMIT")
      transactionOpen = false
    } finally {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  } finally {
    await pool.end()
  }
  configSnapshot = writeBackupConfigSnapshot(destination, config)
} catch (error) {
  if (databaseCreated && existsSync(destination)) unlinkSync(destination)
  throw error
}

const retentionDays = postgresConfig.backupRetentionDays
const cutoff = Date.now() - retentionDays * 86_400_000
const pruned = retentionDays === 0
  ? []
  : findPrunablePostgresBackups({
      backupDirectory: dirname(destination),
      destination,
      retentionCutoff: cutoff,
    })
for (const path of pruned) removeBackupAndConfigSnapshot(path)
const ssl = resolveLibpqSslMode(postgresConfig)
console.log(JSON.stringify({
  event: "postgres.backup.ok",
  destination,
  configSnapshot,
  sslMode: ssl.mode,
  sslModeSource: ssl.source,
  pruned: pruned.length,
}))
