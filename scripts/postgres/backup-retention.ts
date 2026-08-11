import { readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  hasBackupConfigSnapshot,
  loadBackupConfigSnapshot,
} from "../ops/trusted-config"

function samePath(left: string, right: string) {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

export interface PostgresRetentionOptions {
  backupDirectory: string
  destination: string
  retentionCutoff: number
  workingDirectory?: string
}

/**
 * 只清理能由严格配置 pair 证明为 MoeMail PostgreSQL 归档的文件。
 * 无 pair、损坏 pair、其他目录的归档及本次 destination 一律保留。
 */
export function findPrunablePostgresBackups({
  backupDirectory,
  destination,
  retentionCutoff,
  workingDirectory = process.cwd(),
}: PostgresRetentionOptions) {
  const absoluteDirectory = resolve(backupDirectory)
  const absoluteDestination = resolve(destination)

  return readdirSync(absoluteDirectory)
    .filter(name => /^(?:moemail|pre-restore)-.+\.dump$/.test(name))
    .map(name => resolve(absoluteDirectory, name))
    .filter(path => !samePath(path, absoluteDestination))
    .filter(path => {
      let stats
      try {
        stats = statSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      }
      return stats.isFile() && stats.mtimeMs < retentionCutoff
    })
    .filter(path => {
      if (!hasBackupConfigSnapshot(path)) return false
      try {
        const paired = loadBackupConfigSnapshot(path)
        if (paired.database.driver !== "postgres") return false
        const pairedBackupDirectory = resolve(
          workingDirectory,
          paired.database.postgres.backupDir,
        )
        return samePath(dirname(path), pairedBackupDirectory)
      } catch {
        return false
      }
    })
}
