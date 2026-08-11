import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import {
  parseConfigDocument,
  readLastKnownGoodFile,
  resolveConfigPath,
} from "../../app/lib/config/file"
import { parseConfig, type AppConfig } from "../../app/lib/config/schema"

const POLL_INTERVAL_MS = 5_000
const tsxCli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs")

type JobName = "cleanup" | "backup" | "monitor" | "offsite"

const jobScripts: Record<JobName, string> = {
  cleanup: "scripts/cleanup.ts",
  backup: "scripts/database/backup.ts",
  monitor: "scripts/ops/monitor.ts",
  offsite: "scripts/ops/offsite-backup.ts",
}

interface JobState {
  intervalMs: number
  nextRunAt: number
}

const jobs = new Map<JobName, JobState>()
let active = false
let stopping = false
let activeChild: ChildProcess | null = null
let previousBackupOnStart = false
let previousOffsiteRemote: string | null = null
let lastConfigError: string | null = null

function log(event: string, payload: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...payload }))
}

function readTrustedConfig(): AppConfig | null {
  try {
    const snapshot = readLastKnownGoodFile(resolveConfigPath())
    if (!snapshot) return null
    const parsed = parseConfig(parseConfigDocument(snapshot.raw))
    if (!parsed.ok) {
      throw new Error(parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; "))
    }
    if (!parsed.config.setup.completed) return null
    lastConfigError = null
    return parsed.config
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastConfigError) {
      console.error(JSON.stringify({ event: "scheduler.config.failed", message }))
      lastConfigError = message
    }
    return null
  }
}

function intervalMap(config: AppConfig): Record<JobName, number> {
  return {
    cleanup: config.scheduler.cleanupIntervalSeconds * 1_000,
    backup: config.scheduler.backupIntervalSeconds * 1_000,
    monitor: config.monitor.intervalSeconds * 1_000,
    offsite: config.offsite.intervalSeconds * 1_000,
  }
}

function initializeJobs(config: AppConfig, now: number) {
  const intervals = intervalMap(config)
  jobs.set("cleanup", { intervalMs: intervals.cleanup, nextRunAt: now })
  jobs.set("backup", {
    intervalMs: intervals.backup,
    nextRunAt: config.scheduler.backupOnStart ? now : now + intervals.backup,
  })
  jobs.set("monitor", {
    intervalMs: intervals.monitor,
    nextRunAt: now + Math.min(intervals.monitor, 60_000),
  })
  jobs.set("offsite", { intervalMs: intervals.offsite, nextRunAt: now + intervals.offsite })
  previousBackupOnStart = config.scheduler.backupOnStart
  previousOffsiteRemote = config.offsite.remote
  active = true
  log("scheduler.ready", { configPath: resolveConfigPath() })
}

function applyScheduleChanges(config: AppConfig, now: number) {
  const intervals = intervalMap(config)
  for (const name of Object.keys(intervals) as JobName[]) {
    const state = jobs.get(name)
    if (!state || state.intervalMs === intervals[name]) continue
    state.intervalMs = intervals[name]
    state.nextRunAt = now + state.intervalMs
    log("scheduler.config.applied", {
      key: `${name}.intervalMs`,
      value: state.intervalMs,
    })
  }

  if (config.scheduler.backupOnStart !== previousBackupOnStart) {
    previousBackupOnStart = config.scheduler.backupOnStart
    if (previousBackupOnStart) {
      const backup = jobs.get("backup")
      if (backup) backup.nextRunAt = now
    }
    log("scheduler.config.applied", {
      key: "scheduler.backupOnStart",
      value: previousBackupOnStart,
    })
  }

  if (config.offsite.remote !== previousOffsiteRemote) {
    previousOffsiteRemote = config.offsite.remote
    if (previousOffsiteRemote) {
      const offsite = jobs.get("offsite")
      if (offsite) offsite.nextRunAt = now
    }
    log("scheduler.config.applied", {
      key: "offsite.remote",
      configured: Boolean(previousOffsiteRemote),
    })
  }
}

function runJob(name: JobName) {
  return new Promise<boolean>((resolvePromise) => {
    const script = resolve(process.cwd(), jobScripts[name])
    log("scheduler.job.started", { job: name })
    const child = spawn(process.execPath, [tsxCli, script], { stdio: "inherit" })
    activeChild = child
    child.once("error", error => {
      activeChild = null
      console.error(JSON.stringify({
        event: "scheduler.job.failed",
        job: name,
        message: error.message,
      }))
      resolvePromise(false)
    })
    child.once("exit", (code, signal) => {
      activeChild = null
      const ok = code === 0
      const output = {
        event: ok ? "scheduler.job.completed" : "scheduler.job.failed",
        job: name,
        code,
        signal,
      }
      if (ok) console.log(JSON.stringify(output))
      else console.error(JSON.stringify(output))
      resolvePromise(ok)
    })
  })
}

function wait(milliseconds: number) {
  return new Promise<void>(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

if (process.argv.includes("--check")) {
  const config = readTrustedConfig()
  console.log(JSON.stringify({
    event: "scheduler.config.check",
    ready: Boolean(config),
  }))
  process.exit(config ? 0 : 75)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    stopping = true
    activeChild?.kill(signal)
  })
}

while (!stopping) {
  const config = readTrustedConfig()
  if (!config) {
    if (active) log("scheduler.paused", { reason: "setup-or-config-not-ready" })
    active = false
    jobs.clear()
    await wait(POLL_INTERVAL_MS)
    continue
  }

  const now = Date.now()
  if (!active) initializeJobs(config, now)
  else applyScheduleChanges(config, now)

  for (const name of ["cleanup", "backup", "monitor", "offsite"] as JobName[]) {
    if (stopping) break
    if (name === "offsite" && !config.offsite.remote) continue
    const state = jobs.get(name)
    if (!state || Date.now() < state.nextRunAt) continue
    await runJob(name)
    state.nextRunAt = Date.now() + state.intervalMs
  }

  await wait(POLL_INTERVAL_MS)
}

log("scheduler.stopped")
