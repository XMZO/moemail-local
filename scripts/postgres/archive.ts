import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { dirname } from "node:path"
import type { AppConfig } from "../../app/lib/config/schema"
import { parsePostgresConnectionUrl } from "../../app/lib/postgres-connection"
import {
  postgresTargetConninfo,
  resolveLibpqSslMode,
  resolvePostgresTarget,
} from "./libpq"

function fsyncFile(path: string) {
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
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

function requirePostgresUrl(config: AppConfig) {
  const databaseUrl = config.database.postgres.url
  if (!databaseUrl) {
    throw new Error("database.postgres.url is required")
  }
  return databaseUrl
}

export function libpqEnvironment(config: AppConfig) {
  const postgresConfig = config.database.postgres
  const parsedUrl = parsePostgresConnectionUrl(requirePostgresUrl(config))
  const target = resolvePostgresTarget(postgresConfig)
  const ssl = resolveLibpqSslMode(postgresConfig)

  const environment: NodeJS.ProcessEnv = { ...process.env }
  // 连接配置只能来自已验证 YAML/URL；保留 PATH 等进程环境，但清掉 libpq 隐式配置源。
  for (const key of Object.keys(environment)) {
    if (/^PG/i.test(key)) delete environment[key]
  }
  Object.assign(environment, {
    PGHOST: target.host,
    PGPORT: target.port,
    PGUSER: target.user,
    PGPASSWORD: parsedUrl.password,
    PGDATABASE: target.database,
    PGAPPNAME: postgresConfig.applicationName,
    PGSSLMODE: ssl.mode,
  })
  if (ssl.mode === "verify-full") environment.PGSSLROOTCERT = "system"
  return environment
}

async function runTool(command: string, args: string[], config: AppConfig) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: libpqEnvironment(config),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", chunk => {
      if (stderr.length < 64_000) stderr += chunk
    })
    child.on("error", error => {
      reject(new Error(`Unable to run ${command}: ${error.message}`))
    })
    child.on("close", code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))
      }
    })
  })
}

export async function validateArchive(source: string, config: AppConfig) {
  await runTool("pg_restore", ["--list", source], config)
}

export async function createArchive(
  destination: string,
  config: AppConfig,
  options: { snapshot?: string } = {},
) {
  const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`
  const temporaryDestination = `${destination}.${nonce}.tmp`
  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination) || existsSync(temporaryDestination)) {
    throw new Error(`Backup destination already exists: ${destination}`)
  }

  try {
    await runTool("pg_dump", [
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-privileges",
      ...(options.snapshot ? [`--snapshot=${options.snapshot}`] : []),
      `--file=${temporaryDestination}`,
    ], config)
    await validateArchive(temporaryDestination, config)
    if (statSync(temporaryDestination).size === 0) {
      throw new Error("pg_dump created an empty archive")
    }
    chmodSync(temporaryDestination, 0o600)
    fsyncFile(temporaryDestination)
    // hard-link 是同卷原子且不覆盖；并发指定同一目标时只有一个进程能取得所有权。
    linkSync(temporaryDestination, destination)
    chmodSync(destination, 0o600)
    unlinkSync(temporaryDestination)
    fsyncDirectory(dirname(destination))
  } catch (error) {
    if (existsSync(temporaryDestination)) unlinkSync(temporaryDestination)
    throw error
  }

  return destination
}

export async function restoreArchive(source: string, config: AppConfig) {
  await validateArchive(source, config)
  await runTool("pg_restore", [
    `--dbname=${postgresTargetConninfo(config.database.postgres)}`,
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-privileges",
    source,
  ], config)
}
