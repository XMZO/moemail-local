import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { withTemporaryRcloneConfig } from "./rclone-config"
import {
  buildOffsiteArtifacts,
  isOffsiteDatabaseBackup,
} from "./offsite-artifacts"
import {
  hasBackupConfigSnapshot,
  loadBackupConfigSnapshot,
  loadTrustedLastKnownGoodConfig,
} from "./trusted-config"

// 运维 sidecar 只解析 runtime 已写好的 LKG，不导入 runtime，也不触发数据库探测或迁移。
const config = loadTrustedLastKnownGoodConfig()
const databaseDriver = config.database.driver
const backupDirectory = resolve(
  process.cwd(),
  databaseDriver === "postgres"
    ? config.database.postgres.backupDir
    : config.database.sqlite.backupDir,
)
const remote = config.offsite.remote
if (!remote) {
  console.log(JSON.stringify({ event: "offsite-backup.skipped", reason: "not_configured" }))
  process.exit(0)
}
if (!existsSync(backupDirectory)) {
  throw new Error(`Backup directory does not exist: ${backupDirectory}`)
}

const candidates = readdirSync(backupDirectory)
  .map(name => resolve(backupDirectory, name))
  .filter(path => (
    isOffsiteDatabaseBackup(path, databaseDriver)
    && statSync(path).isFile()
    && hasBackupConfigSnapshot(path)
  ))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
const latest = candidates[0]
if (!latest) throw new Error(`No complete paired backup found in ${backupDirectory}`)

const pairedConfig = loadBackupConfigSnapshot(latest)
if (pairedConfig.database.driver !== databaseDriver) {
  throw new Error("Latest backup's paired config selects a different database driver")
}

const artifacts = buildOffsiteArtifacts(latest, remote)
withTemporaryRcloneConfig(config.offsite.rcloneConfigContent, temporaryConfigPath => {
  for (const artifact of artifacts) {
    const arguments_ = [
      "copyto",
      artifact.source,
      artifact.destination,
      "--checksum",
      "--immutable",
    ]
    if (temporaryConfigPath) {
      arguments_.push("--config", temporaryConfigPath)
    }

    const result = spawnSync(config.offsite.rcloneBin, arguments_, { stdio: "inherit" })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`rclone exited with status ${result.status}`)
    }
  }
})

console.log(JSON.stringify({ event: "offsite-backup.ok", artifacts }))
