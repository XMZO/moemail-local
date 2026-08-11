import { existsSync } from "node:fs"
import {
  parseConfigDocument,
  readConfigFile,
  resolveConfigPath,
  resolveLastKnownGoodPath,
} from "../../app/lib/config/file"
import {
  type AppConfig,
  formatIssues,
  parseConfig,
} from "../../app/lib/config/schema"

export const BACKUP_CONFIG_SUFFIX = ".config.yaml.lkg"

/**
 * 只做纯文件解析与完整 schema 校验，不加载 runtime，也不会连接、探测或迁移数据库。
 * 调用方只能把此前由 runtime 生成的 LKG 交给这里。
 */
export function loadTrustedConfigFile(path: string): AppConfig {
  const snapshot = readConfigFile(path)
  if (!snapshot) throw new Error(`Validated config snapshot does not exist: ${path}`)

  const parsed = parseConfig(parseConfigDocument(snapshot.raw))
  if (!parsed.ok) {
    throw new Error(`Validated config snapshot is invalid: ${formatIssues(parsed.issues)}`)
  }
  if (!parsed.config.setup.completed) {
    throw new Error(`Validated config snapshot is not initialized: ${path}`)
  }
  return parsed.config
}

export function loadTrustedLastKnownGoodConfig(
  primaryPath = resolveConfigPath(),
): AppConfig {
  return loadTrustedConfigFile(resolveLastKnownGoodPath(primaryPath))
}

export function backupConfigSnapshotPath(databaseBackupPath: string) {
  return `${databaseBackupPath}${BACKUP_CONFIG_SUFFIX}`
}

export function loadBackupConfigSnapshot(databaseBackupPath: string): AppConfig {
  return loadTrustedConfigFile(backupConfigSnapshotPath(databaseBackupPath))
}

export function hasBackupConfigSnapshot(databaseBackupPath: string) {
  return existsSync(backupConfigSnapshotPath(databaseBackupPath))
}
