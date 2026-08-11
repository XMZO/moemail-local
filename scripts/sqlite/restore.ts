import { randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve } from "node:path"
import Database from "better-sqlite3"
import {
  resolveConfigPath,
  resolveLastKnownGoodPath,
  stringifyConfig,
} from "../../app/lib/config/file"
import type { AppConfig } from "../../app/lib/config/schema"
import { loadBackupConfigSnapshot } from "../ops/trusted-config"
import { resolveDatabasePath, verifyDatabase } from "./lib"

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
  // 数据库已经切换到 recovery 内容。先提交 primary，保证崩溃冷启动时
  // 不会优先加载仍然有效、但与新数据库密钥不匹配的旧 primary。
  const raw = Buffer.from(stringifyConfig(config), "utf8")
  writeRawAtomic(snapshot.primaryPath, raw)
  writeRawAtomic(snapshot.lastKnownGoodPath, raw)
  rmSync(snapshot.setupTokenPath, { force: true })
  if (existsSync(dirname(snapshot.setupTokenPath))) {
    fsyncDirectory(dirname(snapshot.setupTokenPath))
  }
}

function unlinkIfExists(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

const sourceArgument = process.argv[2]
const force = process.argv.includes("--force")

if (!sourceArgument) {
  throw new Error("Usage: pnpm db:sqlite:restore <backup.db> --force")
}
if (!force) {
  throw new Error("Restore replaces the current database; rerun with --force while the app is stopped")
}

const unresolvedSource = resolve(process.cwd(), sourceArgument)
if (!existsSync(unresolvedSource)) {
  throw new Error(`Backup file does not exist: ${unresolvedSource}`)
}
const source = realpathSync(unresolvedSource)
const recoveryConfig = loadBackupConfigSnapshot(source)
if (recoveryConfig.database.driver !== "sqlite") {
  throw new Error("Backup config snapshot does not select SQLite")
}
const installedConfig = captureInstalledConfig()
const destination = resolveDatabasePath(recoveryConfig.database.sqlite.path)
if (source === destination) {
  throw new Error("Backup source and database destination must differ")
}

const timestamp = new Date().toISOString().replaceAll(":", "-")
const temporaryDestination = `${destination}.restore.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
const stagedSource = `${temporaryDestination}.source`
const previousDestination = `${destination}.pre-restore-${timestamp}.bak`
const movedFiles: Array<{ from: string; to: string }> = []
mkdirSync(dirname(destination), { recursive: true })
for (const path of [
  temporaryDestination,
  stagedSource,
  `${stagedSource}-wal`,
  `${stagedSource}-shm`,
  `${temporaryDestination}-wal`,
  `${temporaryDestination}-shm`,
  previousDestination,
  `${previousDestination}-wal`,
  `${previousDestination}-shm`,
]) {
  if (existsSync(path)) throw new Error(`Restore destination already exists: ${path}`)
}

try {
  // 有 WAL 的来源直接使用 Online Backup API，以包含已提交 WAL。无 WAL 的
  // standalone 归档先复制到私有可写 staging，避免 SQLite 为 WAL-mode header
  // 在只读源目录创建 -shm/-wal。已有 WAL 的来源若打不开就安全拒绝，绝不
  // 非原子复制 main/WAL。
  const sourceHasWal = existsSync(`${source}-wal`)
  const snapshotSource = sourceHasWal ? source : stagedSource
  if (snapshotSource === stagedSource) copyFileSync(source, stagedSource)
  const sourceDatabase = new Database(snapshotSource, { readonly: true, fileMustExist: true })
  try {
    await sourceDatabase.backup(temporaryDestination)
  } finally {
    sourceDatabase.close()
  }
  chmodSync(temporaryDestination, 0o600)
  const temporaryVerification = verifyDatabase(temporaryDestination)
  if (temporaryVerification.securityInvariants.emperorUsers !== 1) {
    throw new Error("SQLite restore copy must contain exactly one emperor user")
  }
  unlinkIfExists(`${temporaryDestination}-wal`)
  unlinkIfExists(`${temporaryDestination}-shm`)
  unlinkIfExists(stagedSource)
  unlinkIfExists(`${stagedSource}-wal`)
  unlinkIfExists(`${stagedSource}-shm`)
} catch (error) {
  unlinkIfExists(temporaryDestination)
  unlinkIfExists(`${temporaryDestination}-wal`)
  unlinkIfExists(`${temporaryDestination}-shm`)
  unlinkIfExists(stagedSource)
  unlinkIfExists(`${stagedSource}-wal`)
  unlinkIfExists(`${stagedSource}-shm`)
  throw error
}

let movedPrevious = false
let restoredDestinationCreated = false
let configInstallStarted = false
let verification: ReturnType<typeof verifyDatabase>
try {
  if (existsSync(destination)) {
    renameSync(destination, previousDestination)
    movedFiles.push({ from: previousDestination, to: destination })
    movedPrevious = true
  }
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${destination}${suffix}`
    if (existsSync(sidecar)) {
      const previousSidecar = `${previousDestination}${suffix}`
      renameSync(sidecar, previousSidecar)
      movedFiles.push({ from: previousSidecar, to: sidecar })
    }
  }
  renameSync(temporaryDestination, destination)
  chmodSync(destination, 0o600)
  restoredDestinationCreated = true
  verification = verifyDatabase(destination)
  if (verification.securityInvariants.emperorUsers !== 1) {
    throw new Error("Restored SQLite database must contain exactly one emperor user")
  }

  configInstallStarted = true
  installRecoveryConfig(installedConfig, recoveryConfig)
} catch (restoreError) {
  let databaseRollbackError: unknown
  let configRollbackError: unknown
  try {
    if (restoredDestinationCreated) {
      unlinkIfExists(destination)
      unlinkIfExists(`${destination}-wal`)
      unlinkIfExists(`${destination}-shm`)
    }
    for (const movedFile of movedFiles.reverse()) {
      if (existsSync(movedFile.from) && !existsSync(movedFile.to)) {
        renameSync(movedFile.from, movedFile.to)
      }
    }
  } catch (error) {
    databaseRollbackError = error
  }
  if (configInstallStarted) {
    try {
      restoreInstalledConfig(installedConfig)
    } catch (error) {
      configRollbackError = error
    }
  }
  unlinkIfExists(temporaryDestination)
  unlinkIfExists(`${temporaryDestination}-wal`)
  unlinkIfExists(`${temporaryDestination}-shm`)
  unlinkIfExists(stagedSource)
  unlinkIfExists(`${stagedSource}-wal`)
  unlinkIfExists(`${stagedSource}-shm`)

  if (databaseRollbackError || configRollbackError) {
    throw new Error(
      `SQLite restore failed and rollback was incomplete (database=${
        databaseRollbackError ? "failed" : "ok"
      }, config=${configRollbackError ? "failed" : "ok"})`,
      { cause: restoreError },
    )
  }
  throw new Error("SQLite restore failed; database and config were rolled back", {
    cause: restoreError,
  })
}

console.log(JSON.stringify({
  event: "sqlite.restore.ok",
  source,
  destination,
  previous: movedPrevious ? previousDestination : null,
  recoveryConfigInstalled: true,
  ...verification,
}))
