import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { openSqliteConnection, resolveSqlitePath } from "../../app/lib/db"
import {
  removeBackupAndConfigSnapshot,
  writeBackupConfigSnapshot,
} from "../ops/backup-config-snapshot"
import { backupConfigSnapshotPath } from "../ops/trusted-config"
import { requireValidatedRuntimeConfig } from "../ops/validated-runtime"
import { findPrunableSqliteBackups } from "./backup-retention"
import { verifyDatabase } from "./lib"

process.umask(0o077)

const config = await requireValidatedRuntimeConfig("SQLite backup")
if (config.database.driver !== "sqlite") {
  throw new Error("请先在 data/config.yaml 中选择 SQLite")
}

const source = resolveSqlitePath(config)
if (source === ":memory:") {
  throw new Error("Cannot back up an in-memory database")
}

const timestamp = new Date().toISOString().replaceAll(":", "-")
const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`
const sqliteConfig = config.database.sqlite
const backupDirectory = sqliteConfig.backupDir
const destination = resolve(
  process.cwd(),
  process.argv[2] || `${backupDirectory}/moemail-${timestamp}-${nonce}.db`,
)
const temporaryDestination = `${destination}.${nonce}.tmp`
const temporarySidecars = [
  `${temporaryDestination}-shm`,
  `${temporaryDestination}-wal`,
]
const configSnapshotDestination = backupConfigSnapshotPath(destination)

function unlinkIfExists(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

mkdirSync(dirname(destination), { recursive: true })
if (
  existsSync(destination)
  || existsSync(temporaryDestination)
  || existsSync(configSnapshotDestination)
) {
  throw new Error(`Backup destination already exists: ${destination}`)
}

let databaseCreated = false
let pairCompleted = false
const opened = openSqliteConnection(config)
if (opened.databasePath !== source) {
  opened.sqlite.close()
  throw new Error("Captured SQLite backup path changed unexpectedly")
}
const sqlite = opened.sqlite
try {
  await sqlite.backup(temporaryDestination)
  chmodSync(temporaryDestination, 0o600)
  const verification = verifyDatabase(temporaryDestination)
  if (verification.securityInvariants.emperorUsers !== 1) {
    throw new Error("SQLite backup must contain exactly one emperor user")
  }
  for (const path of temporarySidecars) unlinkIfExists(path)
  // hard-link 是同卷原子且不覆盖；并发指定同一目标时只有一个进程能取得所有权。
  linkSync(temporaryDestination, destination)
  chmodSync(destination, 0o600)
  unlinkSync(temporaryDestination)
  databaseCreated = true
  const configSnapshot = writeBackupConfigSnapshot(destination, config)
  pairCompleted = true
  const retentionDays = sqliteConfig.backupRetentionDays
  const retentionCutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000
  const pruned = findPrunableSqliteBackups({
    backupDirectory: dirname(destination),
    source,
    destination,
    retentionCutoff,
  })
  for (const path of pruned) removeBackupAndConfigSnapshot(path)
  console.log(JSON.stringify({
    event: "sqlite.backup.ok",
    source,
    destination,
    configSnapshot,
    pruned: pruned.length,
    ...verification,
  }))
} catch (error) {
  unlinkIfExists(temporaryDestination)
  for (const path of temporarySidecars) unlinkIfExists(path)
  if (databaseCreated && !pairCompleted) unlinkIfExists(destination)
  throw error
} finally {
  sqlite.close()
}
