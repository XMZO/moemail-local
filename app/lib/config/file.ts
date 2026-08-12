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
import { Document, isMap, isPair, parse } from "yaml"
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
      location = `，第 ${lines.length} 行，第 ${(lines.at(-1)?.length ?? 0) + 1} 列`
    }
    throw new Error(`YAML 语法错误（${code}${location}）`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置文件的顶层必须是键值对")
  }
  return parsed
}

const FILE_HEADER = [
  " MoeMail 运行配置",
  "",
  " - 本文件是唯一的运行时配置来源，不再使用环境变量或 .env。",
  " - 直接编辑本文件即可生效：进程会检测改动、校验后热加载；校验失败会保留上一份可用配置。",
  " - 也可以在 WebUI「运行配置」面板中修改，保存后会写回本文件。",
  " - 文件含明文密钥，权限应保持 0600。",
].join("\n")

const SECTION_COMMENTS: Record<string, string> = {
  setup: " 首次启动向导的完成状态；置为 false 会重新进入初始化向导。",
  server: " 站点地址与前端行为。反向代理终止 TLS 时请开启 trustProxyHeaders。",
  database: " 数据库类型与连接参数。切换 driver 需要重启进程（默认自动重启）。",
  auth: " 会话密钥、OAuth 与登录防滥用限制。",
  email: " Email Worker 入站投递鉴权；外部 IMAP/SMTP 凭据按域保存在站点配置中。",
  cleanup: " 过期邮箱清理任务的批量参数。",
  scheduler: " Docker / systemd 常驻 scheduler 的执行间隔。",
  monitor: " 磁盘、WAL、HTTP 5xx 与投递失败的监控阈值。",
  offsite: " rclone 异地备份同步。",
}

export function stringifyConfig(config: AppConfig) {
  const document = new Document(config)
  document.commentBefore = FILE_HEADER

  const contents = document.contents
  if (isMap(contents)) {
    for (const item of contents.items) {
      if (!isPair(item)) continue
      const key = (item.key as { value?: unknown })?.value
      const comment = typeof key === "string" ? SECTION_COMMENTS[key] : undefined
      if (comment && item.key && typeof item.key === "object") {
        ;(item.key as { commentBefore?: string }).commentBefore = comment
      }
    }
  }

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
