import { basename } from "node:path"
import { backupConfigSnapshotPath } from "./trusted-config"

export interface OffsiteArtifact {
  source: string
  destination: string
}

/** safety backup 只用于本地自动回滚，不能冒充正常异地恢复点。 */
export function isOffsiteDatabaseBackup(
  path: string,
  driver: "sqlite" | "postgres",
) {
  const name = basename(path)
  return driver === "postgres"
    ? /^moemail-.+\.dump$/.test(name)
    : /^moemail-.+\.db$/.test(name)
}

/** 数据库备份与当时的已验证配置快照使用同一远端文件名前缀。 */
export function buildOffsiteArtifacts(
  databaseBackupPath: string,
  remote: string,
): OffsiteArtifact[] {
  const remoteRoot = remote.replace(/\/$/, "")
  const backupName = basename(databaseBackupPath)
  return [
    {
      source: databaseBackupPath,
      destination: `${remoteRoot}/${backupName}`,
    },
    {
      source: backupConfigSnapshotPath(databaseBackupPath),
      destination: `${remoteRoot}/${backupName}.config.yaml.lkg`,
    },
  ]
}
