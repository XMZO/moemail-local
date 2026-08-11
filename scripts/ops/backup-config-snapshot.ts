import { existsSync, unlinkSync } from "node:fs"
import { writeConfigFile } from "../../app/lib/config/file"
import { type AppConfig, formatIssues, parseConfig } from "../../app/lib/config/schema"
import { backupConfigSnapshotPath } from "./trusted-config"

function unlinkIfExists(path: string) {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/**
 * 把创建数据库备份时冻结的、已经验证的配置写到相邻文件。
 * 任一步失败时调用方必须删除数据库备份，不能留下看似完整的单文件恢复点。
 */
export function writeBackupConfigSnapshot(
  databaseBackupPath: string,
  config: AppConfig,
) {
  if (!existsSync(databaseBackupPath)) {
    throw new Error(`Database backup does not exist: ${databaseBackupPath}`)
  }

  const validated = parseConfig(config)
  if (!validated.ok) {
    throw new Error(`Cannot pair an invalid config: ${formatIssues(validated.issues)}`)
  }
  if (!validated.config.setup.completed) {
    throw new Error("Cannot pair an incomplete setup config")
  }

  const snapshotPath = backupConfigSnapshotPath(databaseBackupPath)
  if (existsSync(snapshotPath)) {
    throw new Error(`Backup config snapshot already exists: ${snapshotPath}`)
  }

  try {
    writeConfigFile(snapshotPath, validated.config)
  } catch (error) {
    unlinkIfExists(snapshotPath)
    throw error
  }
  return snapshotPath
}

/** 删除过期数据库备份时，同步清理其相邻配置；孤立配置比孤立数据库更安全。 */
export function removeBackupAndConfigSnapshot(databaseBackupPath: string) {
  unlinkIfExists(databaseBackupPath)
  unlinkIfExists(backupConfigSnapshotPath(databaseBackupPath))
}
