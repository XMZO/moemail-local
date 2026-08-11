import { randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import { createPostgresPool } from "../../app/lib/db"
import {
  resolveConfigPath,
  resolveLastKnownGoodPath,
  stringifyConfig,
} from "../../app/lib/config/file"
import type { AppConfig } from "../../app/lib/config/schema"
import {
  backupConfigSnapshotPath,
  loadBackupConfigSnapshot,
} from "../ops/trusted-config"
import { createArchive, restoreArchive, validateArchive } from "./archive"
import { verifyPostgres } from "./lib"
import { resolveLibpqSslMode } from "./libpq"

process.umask(0o077)

interface InstalledConfigSnapshot {
  primaryPath: string
  lastKnownGoodPath: string
  setupTokenPath: string
  primaryRaw: Buffer | null
  lastKnownGoodRaw: Buffer | null
  setupTokenRaw: Buffer | null
}

function readOptionalRaw(path: string) {
  try {
    return readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function captureInstalledConfig(): InstalledConfigSnapshot {
  const primaryPath = resolveConfigPath()
  const lastKnownGoodPath = resolveLastKnownGoodPath(primaryPath)
  const setupTokenPath = resolve(dirname(primaryPath), "setup-token")
  return {
    primaryPath,
    lastKnownGoodPath,
    setupTokenPath,
    primaryRaw: readOptionalRaw(primaryPath),
    lastKnownGoodRaw: readOptionalRaw(lastKnownGoodPath),
    setupTokenRaw: readOptionalRaw(setupTokenPath),
  }
}

function fsyncDirectory(path: string) {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "r")
    fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function writeRawAtomic(path: string, raw: Buffer) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  let descriptor: number | undefined
  let temporaryCreated = false
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600)
    temporaryCreated = true
    writeFileSync(descriptor, raw)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try { chmodSync(temporaryPath, 0o600) } catch {}
    renameSync(temporaryPath, path)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    if (temporaryCreated) rmSync(temporaryPath, { force: true })
    throw error
  }
}

function restoreInstalledConfig(snapshot: InstalledConfigSnapshot) {
  for (const [path, raw] of [
    [snapshot.primaryPath, snapshot.primaryRaw],
    [snapshot.lastKnownGoodPath, snapshot.lastKnownGoodRaw],
    [snapshot.setupTokenPath, snapshot.setupTokenRaw],
  ] as const) {
    const currentRaw = readOptionalRaw(path)
    if (raw === null) {
      if (currentRaw !== null) {
        rmSync(path, { force: true })
        if (existsSync(dirname(path))) fsyncDirectory(dirname(path))
      }
    } else if (!currentRaw?.equals(raw)) {
      writeRawAtomic(path, raw)
    }
  }
}

function installRecoveryConfig(snapshot: InstalledConfigSnapshot, config: AppConfig) {
  // 数据库已经切换到 recovery 内容；primary 必须先于 LKG 提交。
  const raw = Buffer.from(stringifyConfig(config), "utf8")
  writeRawAtomic(snapshot.primaryPath, raw)
  writeRawAtomic(snapshot.lastKnownGoodPath, raw)
  rmSync(snapshot.setupTokenPath, { force: true })
  if (existsSync(dirname(snapshot.setupTokenPath))) {
    fsyncDirectory(dirname(snapshot.setupTokenPath))
  }
}

const sourceArgument = process.argv[2]
const force = process.argv.includes("--force")

if (!sourceArgument) {
  throw new Error("Usage: pnpm db:postgres:restore <backup.dump> --force")
}
if (!force) {
  throw new Error(
    "Restore replaces the current database; rerun with --force while all app processes are stopped",
  )
}

const unresolvedSource = resolve(process.cwd(), sourceArgument)
if (!existsSync(unresolvedSource)) {
  throw new Error(`Backup file does not exist: ${unresolvedSource}`)
}
const source = realpathSync(unresolvedSource)
const recoveryConfig = loadBackupConfigSnapshot(source)
if (recoveryConfig.database.driver !== "postgres") {
  throw new Error("Backup config snapshot does not select PostgreSQL")
}
const installedConfig = captureInstalledConfig()
const timestamp = new Date().toISOString().replaceAll(":", "-")
const backupDirectory = recoveryConfig.database.postgres.backupDir
const safetyBackup = resolve(
  process.cwd(),
  `${backupDirectory}/pre-restore-${timestamp}.dump`,
)
const misleadingSafetyPair = backupConfigSnapshotPath(safetyBackup)
if (
  existsSync(safetyBackup)
  || existsSync(misleadingSafetyPair)
) {
  throw new Error(`Safety backup destination already exists: ${safetyBackup}`)
}

let pool: ReturnType<typeof createPostgresPool> | null = null
let safetyBackupCreated = false
let databaseMutated = false
let configInstallStarted = false
let verification: Awaited<ReturnType<typeof verifyPostgres>>
try {
  // 先验证归档容器格式；坏来源不应触发 safety dump 或目标库回写。
  await validateArchive(source, recoveryConfig)
  await createArchive(safetyBackup, recoveryConfig)
  safetyBackupCreated = true

  await restoreArchive(source, recoveryConfig)
  databaseMutated = true
  pool = createPostgresPool(recoveryConfig)
  verification = await verifyPostgres(pool)
  if (verification.securityInvariants.emperorUsers !== 1) {
    throw new Error("Restored PostgreSQL database must contain exactly one emperor user")
  }
  await pool.end()
  pool = null

  configInstallStarted = true
  installRecoveryConfig(installedConfig, recoveryConfig)
} catch (restoreError) {
  await pool?.end().catch(() => undefined)
  pool = null
  let databaseRollbackError: unknown
  let configRollbackError: unknown

  if (safetyBackupCreated && databaseMutated) {
    try {
      await restoreArchive(safetyBackup, recoveryConfig)
    } catch (error) {
      databaseRollbackError = error
    }
  }
  // 只有数据库已回到旧快照，才恢复旧配置；否则不要主动制造确定的错配。
  if (configInstallStarted && !databaseRollbackError) {
    try {
      restoreInstalledConfig(installedConfig)
    } catch (error) {
      configRollbackError = error
    }
  }

  if (!databaseMutated && !configInstallStarted) {
    throw new Error("PostgreSQL restore was rejected before changing database or config", {
      cause: restoreError,
    })
  }

  if (databaseRollbackError || configRollbackError) {
    throw new Error(
      `PostgreSQL restore failed and rollback was incomplete (database=${
        databaseRollbackError ? "failed" : "ok"
      }, config=${
        databaseRollbackError && configInstallStarted
          ? "skipped"
          : configRollbackError ? "failed" : "ok"
      })`,
      { cause: restoreError },
    )
  }
  throw new Error("PostgreSQL restore failed; database and config were rolled back", {
    cause: restoreError,
  })
} finally {
  await pool?.end().catch(() => undefined)
}

const ssl = resolveLibpqSslMode(recoveryConfig.database.postgres)
console.log(JSON.stringify({
  event: "postgres.restore.ok",
  source,
  safetyBackup,
  safetyBackupPortable: false,
  recoveryConfigInstalled: true,
  sslMode: ssl.mode,
  sslModeSource: ssl.source,
  ...verification,
}))
