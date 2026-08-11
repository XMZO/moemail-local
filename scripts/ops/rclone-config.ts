import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 仅在一次 rclone 调用期间暴露配置内容，结束后递归删除临时目录。 */
export function withTemporaryRcloneConfig<T>(
  content: string | null,
  callback: (path: string | null) => T,
) {
  if (!content) return callback(null)

  const directory = mkdtempSync(join(tmpdir(), "moemail-rclone-"))
  try {
    const path = join(directory, "rclone.conf")
    writeFileSync(path, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    })
    return callback(path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
