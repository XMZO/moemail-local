import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, resolve } from "node:path"
import { Document, parse } from "yaml"
import type { AppConfig } from "./schema"

export const DEFAULT_CONFIG_RELATIVE_PATH = "data/config.yaml"

export function resolveConfigPath() {
  return resolve(process.cwd(), DEFAULT_CONFIG_RELATIVE_PATH)
}

export function resolveLastKnownGoodPath(path: string) {
  return `${path}.lkg`
}

export interface ConfigFileSnapshot {
  raw: string
  mtimeMs: number
  size: number
}

export function statConfigFile(path: string) {
  try {
    const stats = statSync(path)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function readConfigFile(path: string): ConfigFileSnapshot | null {
  try {
    const raw = readFileSync(path, "utf8")
    const stats = statSync(path)
    return { raw, mtimeMs: stats.mtimeMs, size: stats.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function parseConfigDocument(raw: string): unknown {
  let parsed: unknown
  try {
    // prettyErrors 会把出错行原文拼进异常消息。配置行可能含数据库密码、
    // OAuth secret 或 rclone 凭据，因此任何可记录/返回的解析错误都不能
    // 携带源码片段。
    parsed = parse(raw, { prettyErrors: false })
  } catch (error) {
    const details = error as { code?: unknown; pos?: unknown }
    const code = typeof details.code === "string" && /^[A-Z0-9_]+$/.test(details.code)
      ? details.code
      : "YAML_PARSE_ERROR"
    const offset = Array.isArray(details.pos) && Number.isInteger(details.pos[0])
      ? Math.max(0, details.pos[0] as number)
      : null

    let location = ""
    if (offset !== null) {
      const before = raw.slice(0, offset)
      const lines = before.split(/\r\n|\r|\n/)
      location = `:${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`
    }
    throw new Error(`YAML_PARSE_FAILED:${code}${location}`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CONFIG_ROOT_OBJECT_REQUIRED")
  }
  return parsed
}

export function stringifyConfig(config: AppConfig) {
  const document = new Document(config)
  return document.toString({ lineWidth: 0, nullStr: "null" })
}

function fsyncDirectory(path: string) {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "r")
    fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      console.warn(JSON.stringify({
        event: "config.directory-fsync.failed",
        path,
        message: error instanceof Error ? error.message : String(error),
      }))
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {}
    }
  }
}

function writeRawFileAtomic(path: string, raw: string) {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const nonce = randomBytes(12).toString("hex")
  const temporaryPath = `${path}.${process.pid}.${nonce}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600)
    writeFileSync(descriptor, raw, { encoding: "utf8" })
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined

    try {
      chmodSync(temporaryPath, 0o600)
    } catch {
      // Windows 与部分文件系统不支持 POSIX 权限位，忽略即可。
    }

    renameSync(temporaryPath, path)
    fsyncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {}
    }
    rmSync(temporaryPath, { force: true })
    throw error
  }

  try {
    return statConfigFile(path)
  } catch {
    return { mtimeMs: Date.now(), size: Buffer.byteLength(raw, "utf8") }
  }
}

export function writeConfigFile(path: string, config: AppConfig) {
  return writeRawFileAtomic(path, stringifyConfig(config))
}

export function readLastKnownGoodFile(path: string) {
  return readConfigFile(resolveLastKnownGoodPath(path))
}

export function writeLastKnownGoodFile(path: string, config: AppConfig) {
  return writeRawFileAtomic(resolveLastKnownGoodPath(path), stringifyConfig(config))
}
