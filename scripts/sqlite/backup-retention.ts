import { readdirSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { isOffsiteDatabaseBackup } from "../ops/offsite-artifacts"
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

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
) {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino
}

export interface SqliteRetentionOptions {
  backupDirectory: string
  source: string
  destination: string
  retentionCutoff: number
  workingDirectory?: string
}

/**
 * 只返回能证明为 MoeMail SQLite 归档的文件。线上库、当前备份、无配对、
 * 损坏配对及来自其他备份目录的文件一律保留，交给管理员显式处置。
 */
export function findPrunableSqliteBackups({
  backupDirectory,
  source,
  destination,
  retentionCutoff,
  workingDirectory = process.cwd(),
}: SqliteRetentionOptions) {
  const absoluteDirectory = resolve(backupDirectory)
  const absoluteSource = resolve(source)
  const absoluteDestination = resolve(destination)
  const sourceStats = statSync(absoluteSource)

  return readdirSync(absoluteDirectory)
    .map(name => resolve(absoluteDirectory, name))
    .filter(path => isOffsiteDatabaseBackup(path, "sqlite"))
    .filter(path => !samePath(path, absoluteSource) && !samePath(path, absoluteDestination))
    .filter(path => {
      let stats
      try {
        stats = statSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      }
      return stats.isFile()
        && !sameFile(stats, sourceStats)
        && stats.mtimeMs < retentionCutoff
    })
    .filter(path => {
      if (!hasBackupConfigSnapshot(path)) return false
      try {
        const paired = loadBackupConfigSnapshot(path)
        if (paired.database.driver !== "sqlite") return false

        const pairedSource = resolve(workingDirectory, paired.database.sqlite.path)
        const pairedBackupDirectory = resolve(
          workingDirectory,
          paired.database.sqlite.backupDir,
        )
        return !samePath(path, pairedSource)
          && samePath(dirname(path), pairedBackupDirectory)
      } catch {
        return false
      }
    })
}
