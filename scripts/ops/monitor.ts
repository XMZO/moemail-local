import { existsSync, openSync, closeSync, fstatSync, readSync, statfsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  createPostgresPool,
  resolveSqlitePath,
} from "../../app/lib/db"
import { sendOperatorAlert } from "./lib"
import { loadTrustedLastKnownGoodConfig } from "./trusted-config"

interface AccessLogEntry {
  ts?: number
  time?: string
  time_iso8601?: string
  status?: number | string
  uri?: string
  request?: { uri?: string }
}

function readTail(path: string, maximumBytes = 2 * 1024 * 1024) {
  const descriptor = openSync(path, "r")
  try {
    const size = fstatSync(descriptor).size
    const length = Math.min(size, maximumBytes)
    const buffer = Buffer.alloc(length)
    readSync(descriptor, buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    return size > length ? text.slice(text.indexOf("\n") + 1) : text
  } finally {
    closeSync(descriptor)
  }
}

function inspectAccessLog(path: string, windowMinutes: number) {
  const cutoff = Date.now() - windowMinutes * 60_000
  let http5xx = 0
  let ingestionFailures = 0

  for (const line of readTail(path).split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as AccessLogEntry
      const timestamp = typeof entry.ts === "number"
        ? entry.ts * 1_000
        : Date.parse(entry.time || entry.time_iso8601 || "")
      if (!Number.isFinite(timestamp) || timestamp < cutoff) continue

      const status = Number(entry.status)
      const uri = entry.request?.uri || entry.uri || ""
      if (status >= 500) http5xx += 1
      if (uri.startsWith("/api/internal/email") && status >= 300) {
        ingestionFailures += 1
      }
    } catch {
      continue
    }
  }

  return { http5xx, ingestionFailures }
}

const issues: string[] = []
const config = loadTrustedLastKnownGoodConfig()
const monitorConfig = config.monitor
const databaseDriver = config.database.driver
const sqliteDatabasePath = databaseDriver === "sqlite" ? resolveSqlitePath(config) : null
const healthcheckUrl = monitorConfig.healthcheckUrl
  ?? "http://127.0.0.1:3000/api/internal/health"

try {
  const response = await fetch(healthcheckUrl, {
    headers: { "User-Agent": "moemail-monitor/1" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) issues.push(`healthcheck returned HTTP ${response.status}`)
} catch (error) {
  issues.push(`healthcheck failed: ${error instanceof Error ? error.message : String(error)}`)
}

const diskPath = monitorConfig.diskPath
  ? resolve(process.cwd(), monitorConfig.diskPath)
  : databaseDriver === "sqlite"
    ? dirname(sqliteDatabasePath as string)
    // PostgreSQL Compose 只读挂载真实数据卷；裸机/托管 PG 可在 YAML 中显式指定。
    : existsSync("/postgres-data") ? "/postgres-data" : process.cwd()
let freeBytes = BigInt(0)
let freePercent = 0
const minimumFreePercent = monitorConfig.minFreePercent
const minimumFreeBytes = BigInt(Math.floor(
  monitorConfig.minFreeGb * 1024 ** 3,
))
try {
  const disk = statfsSync(diskPath, { bigint: true })
  freeBytes = disk.bavail * disk.bsize
  const totalBytes = disk.blocks * disk.bsize
  freePercent = totalBytes === BigInt(0)
    ? 0
    : Number(freeBytes * BigInt(10_000) / totalBytes) / 100
  if (freePercent < minimumFreePercent || freeBytes < minimumFreeBytes) {
    issues.push(`disk free space is ${freePercent.toFixed(2)}% (${freeBytes} bytes)`)
  }
} catch (error) {
  issues.push(`disk check failed: ${error instanceof Error ? error.message : String(error)}`)
}

let walBytes = 0
let postgresDatabaseBytes = 0
let postgresPool: ReturnType<typeof createPostgresPool> | null = null
if (databaseDriver === "sqlite") {
  const walPath = `${sqliteDatabasePath}-wal`
  walBytes = existsSync(walPath) ? statSync(walPath).size : 0
  const maximumWalBytes = monitorConfig.maxWalMb * 1024 ** 2
  if (walBytes > maximumWalBytes) {
    issues.push(`SQLite WAL is ${walBytes} bytes`)
  }
} else {
  try {
    postgresPool = createPostgresPool(config)
    const sizeResult = await postgresPool.query<{ bytes: string }>(
      "SELECT pg_database_size(current_database())::text AS bytes",
    )
    postgresDatabaseBytes = Number(sizeResult.rows[0].bytes)
    const maximumDatabaseBytes = monitorConfig.maxPostgresDatabaseGb * 1024 ** 3
    if (maximumDatabaseBytes > 0 && postgresDatabaseBytes > maximumDatabaseBytes) {
      issues.push(`PostgreSQL database is ${postgresDatabaseBytes} bytes`)
    }
  } catch (error) {
    issues.push(`PostgreSQL size check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let accessLog = { http5xx: 0, ingestionFailures: 0 }
const accessLogPath = monitorConfig.accessLog
if (accessLogPath) {
  if (!existsSync(accessLogPath)) {
    issues.push(`access log does not exist: ${accessLogPath}`)
  } else {
    try {
      const windowMinutes = monitorConfig.windowMinutes
      accessLog = inspectAccessLog(accessLogPath, windowMinutes)
      if (accessLog.http5xx > monitorConfig.maxHttp5xx) {
        issues.push(`${accessLog.http5xx} HTTP 5xx responses in ${windowMinutes} minutes`)
      }
      if (accessLog.ingestionFailures > monitorConfig.maxIngestFailures) {
        issues.push(`${accessLog.ingestionFailures} ingestion failures in ${windowMinutes} minutes`)
      }
    } catch (error) {
      issues.push(`access log check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const result = {
  event: issues.length === 0 ? "monitor.ok" : "monitor.failed",
  databaseDriver,
  healthcheckUrl,
  diskPath,
  freeBytes: freeBytes.toString(),
  freePercent,
  walBytes,
  postgresDatabaseBytes,
  ...accessLog,
  issues,
}

console.log(JSON.stringify(result))
if (issues.length > 0) {
  await sendOperatorAlert("MoeMail health check failed", result, monitorConfig)
  process.exitCode = 1
}
await postgresPool?.end()
