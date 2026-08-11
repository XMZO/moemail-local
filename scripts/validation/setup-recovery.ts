import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createDefaultConfig } from "../../app/lib/config/schema"
import { stringifyConfig } from "../../app/lib/config/file"
import { buildSetupConfigPatch } from "../../app/lib/setup-service"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-setup-recovery-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const probe = resolve(repositoryRoot, "scripts/validation/setup-recovery-probe.ts")
const lockProbe = resolve(
  repositoryRoot,
  "scripts/validation/setup-operation-lock-probe.ts",
)
const staleTokenProbe = resolve(
  repositoryRoot,
  "scripts/validation/setup-stale-token-probe.ts",
)

interface Result {
  mode: "normal" | "resume" | "conflict"
  ok: boolean
  status: number
  setupCompleted: boolean
  passwordStillWorks: boolean | null
}

function stagedConfig() {
  const defaults = createDefaultConfig()
  return {
    ...defaults,
    setup: { completed: false, completedAt: null },
    server: { ...defaults.server, baseUrl: "http://127.0.0.1:3000" },
    database: {
      ...defaults.database,
      driver: "sqlite" as const,
      sqlite: { ...defaults.database.sqlite, path: "data/setup.db" },
    },
    auth: {
      ...defaults.auth,
      secret: "setup-auth-secret-abcdefghijklmnopqrstuvwxyz-123",
      passwordPepper: "setup-password-pepper-abcdefghijklmnopqrstuvwxyz",
    },
    email: {
      ...defaults.email,
      ingestSecret: "setup-ingest-secret-abcdefghijklmnopqrstuvwxyz-1",
    },
  }
}

function run(mode: Result["mode"]): Result {
  const cwd = join(temporaryRoot, mode)
  mkdirSync(join(cwd, "data"), { recursive: true })
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(cwd, "drizzle-local"), {
    recursive: true,
  })
  if (mode !== "normal") {
    writeFileSync(
      join(cwd, "data/config.yaml"),
      stringifyConfig(stagedConfig()),
      "utf8",
    )
  }

  const output = execFileSync(process.execPath, [tsxCli, probe, mode], {
    cwd,
    encoding: "utf8",
  })
  const marker = output
    .split(/\r?\n/)
    .find(line => line.startsWith("__MOEMAIL_SETUP_PROBE__"))
  if (!marker) throw new Error(`setup probe did not return a result:\n${output}`)
  return JSON.parse(marker.slice("__MOEMAIL_SETUP_PROBE__".length)) as Result
}

function parseLockResult(output: string) {
  const marker = output
    .split(/\r?\n/)
    .find(line => line.startsWith("__MOEMAIL_SETUP_LOCK_PROBE__"))
  if (!marker) throw new Error(`setup lock probe did not return a result:\n${output}`)
  return JSON.parse(marker.slice("__MOEMAIL_SETUP_LOCK_PROBE__".length)) as {
    acquired: boolean
  }
}

function parseStaleTokenResult(output: string) {
  const marker = output
    .split(/\r?\n/)
    .find(line => line.startsWith("__MOEMAIL_SETUP_STALE_TOKEN_PROBE__"))
  if (!marker) {
    throw new Error(`stale setup token probe did not return a result:\n${output}`)
  }
  return JSON.parse(
    marker.slice("__MOEMAIL_SETUP_STALE_TOKEN_PROBE__".length),
  ) as {
    setupCompletedBeforeReload: boolean
    cachedTokenStillAccepted: boolean
    reloadOk: boolean
    setupCompleted: boolean
    deniedStatus: number | null
    tokenFileExists: boolean
  }
}

async function verifyCrossProcessSetupLock() {
  const cwd = join(temporaryRoot, "operation-lock")
  mkdirSync(cwd, { recursive: true })
  const readyPath = join(cwd, "first-ready")
  const first = spawn(process.execPath, [tsxCli, lockProbe, "3000", readyPath], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  first.stdout.on("data", chunk => { stdout += String(chunk) })
  first.stderr.on("data", chunk => { stderr += String(chunk) })

  const deadline = Date.now() + 10_000
  while (!existsSync(readyPath) && Date.now() < deadline) {
    if (first.exitCode !== null) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  assert.equal(existsSync(readyPath), true, `first setup lock probe failed: ${stderr}`)

  const secondOutput = execFileSync(
    process.execPath,
    [tsxCli, lockProbe, "0"],
    { cwd, encoding: "utf8" },
  )
  const firstExit = first.exitCode !== null
    ? first.exitCode
    : await new Promise<number | null>((resolvePromise, reject) => {
      first.once("error", reject)
      first.once("exit", code => resolvePromise(code))
    })
  assert.equal(firstExit, 0, stderr)
  assert.equal(parseLockResult(stdout).acquired, true)
  assert.equal(parseLockResult(secondOutput).acquired, false)
  assert.equal(existsSync(join(cwd, "data/setup-operation.lock")), false)
}

async function verifyStaleSetupTokenRejectedAfterCompletion() {
  const cwd = join(temporaryRoot, "stale-token")
  mkdirSync(join(cwd, "data"), { recursive: true })
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(cwd, "drizzle-local"), {
    recursive: true,
  })

  const readyPath = join(cwd, "waiting-process-ready")
  const continuePath = join(cwd, "setup-completed")
  const waiting = spawn(
    process.execPath,
    [tsxCli, staleTokenProbe, readyPath, continuePath],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  )
  let stdout = ""
  let stderr = ""
  waiting.stdout.on("data", chunk => { stdout += String(chunk) })
  waiting.stderr.on("data", chunk => { stderr += String(chunk) })

  const deadline = Date.now() + 10_000
  while (!existsSync(readyPath) && Date.now() < deadline) {
    if (waiting.exitCode !== null) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25))
  }
  assert.equal(existsSync(readyPath), true, `waiting setup process failed: ${stderr}`)

  // 进程 A 使用同一数据目录完成初始化并删除一次性 token。
  const completedOutput = execFileSync(process.execPath, [tsxCli, probe, "normal"], {
    cwd,
    encoding: "utf8",
  })
  assert.equal(JSON.parse(
    completedOutput
      .split(/\r?\n/)
      .find(line => line.startsWith("__MOEMAIL_SETUP_PROBE__"))!
      .slice("__MOEMAIL_SETUP_PROBE__".length),
  ).ok, true)
  assert.equal(existsSync(join(cwd, "data/setup-token")), false)
  writeFileSync(continuePath, "continue", "utf8")

  const waitingExit = waiting.exitCode !== null
    ? waiting.exitCode
    : await new Promise<number | null>((resolvePromise, reject) => {
      waiting.once("error", reject)
      waiting.once("exit", code => resolvePromise(code))
    })
  assert.equal(waitingExit, 0, stderr)

  const result = parseStaleTokenResult(stdout)
  assert.equal(result.setupCompletedBeforeReload, false)
  assert.equal(result.cachedTokenStillAccepted, false)
  assert.equal(result.reloadOk, true)
  assert.equal(result.setupCompleted, true)
  assert.equal(result.deniedStatus, 409)
  assert.equal(result.tokenFileExists, false)
}

try {
  assert.equal(buildSetupConfigPatch({ advancedYaml: "broken: [" }).ok, false)
  assert.equal(buildSetupConfigPatch({ config: "not-an-object" }).ok, false)

  const normal = run("normal")
  const resumed = run("resume")
  const conflict = run("conflict")

  assert.deepEqual(
    [normal.ok, resumed.ok, conflict.ok],
    [true, true, false],
  )
  assert.equal(resumed.passwordStillWorks, true)
  assert.equal(conflict.status, 409)
  await verifyCrossProcessSetupLock()
  await verifyStaleSetupTokenRejectedAfterCompletion()

  console.log(JSON.stringify({
    firstSetupCompleted: true,
    stagedSetupResumedWithSamePepper: true,
    existingDifferentOwnerRejected: true,
    invalidSetupPayloadRejected: true,
    crossProcessSetupOperationLock: true,
    staleCachedSetupTokenInvalidated: true,
    staleCrossProcessSetupTokenRejected: true,
  }, null, 2))
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
