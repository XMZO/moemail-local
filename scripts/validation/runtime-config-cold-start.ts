import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { execFileSync, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseConfigDocument, stringifyConfig } from "../../app/lib/config/file"
import { createDefaultConfig, parseConfig } from "../../app/lib/config/schema"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-config-cold-start-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const probeScript = resolve(
  repositoryRoot,
  "scripts/validation/runtime-config-cold-probe.ts",
)
const setupProbeScript = resolve(
  repositoryRoot,
  "scripts/validation/setup-recovery-probe.ts",
)
const instrumentationProbeScript = resolve(
  repositoryRoot,
  "scripts/validation/instrumentation-cold-probe.ts",
)

interface ProbeResult {
  before: ReturnType<typeof import("../../app/lib/config/runtime").getConfigStatus>
  unverifiedGetConfigRejected: boolean
  reload: { ok: boolean; issues: Array<{ path: string; message: string }> }
  after: ReturnType<typeof import("../../app/lib/config/runtime").getConfigStatus>
  activeDriver: "sqlite" | "postgres" | null
  boundDriver: "sqlite" | "postgres" | null
  databaseOpened: boolean
  recoveryCandidate: {
    setupCompleted: boolean
    passwordPepperPresent: boolean
  }
}

interface InstrumentationProbeResult {
  mode: "instrumentation" | "maintenance"
  elapsedMs: number
  status: ReturnType<typeof import("../../app/lib/config/runtime").getConfigStatus>
  activeDriver: "sqlite" | "postgres"
  boundDriver: "sqlite" | "postgres"
  databaseOpened: boolean
}

function runProbe(cwd: string): ProbeResult {
  const output = execFileSync(process.execPath, [tsxCli, probeScript], {
    cwd,
    encoding: "utf8",
  })
  const marker = output
    .split(/\r?\n/)
    .find(line => line.startsWith("__MOEMAIL_COLD_PROBE__"))
  if (!marker) throw new Error(`cold probe did not return a result:\n${output}`)
  return JSON.parse(marker.slice("__MOEMAIL_COLD_PROBE__".length)) as ProbeResult
}

function runInstrumentationProbe(cwd: string, mode: "instrumentation" | "maintenance") {
  const execution = spawnSync(process.execPath, [
    tsxCli,
    instrumentationProbeScript,
    ...(mode === "maintenance" ? ["--maintenance"] : []),
  ], {
    cwd,
    encoding: "utf8",
  })
  assert.equal(execution.status, 0, execution.stderr || execution.stdout)
  const marker = execution.stdout
    .split(/\r?\n/)
    .find(line => line.startsWith("__MOEMAIL_INSTRUMENTATION_PROBE__"))
  if (!marker) {
    throw new Error(`instrumentation probe did not return a result:\n${execution.stdout}`)
  }
  return {
    output: `${execution.stdout}\n${execution.stderr}`,
    result: JSON.parse(
      marker.slice("__MOEMAIL_INSTRUMENTATION_PROBE__".length),
    ) as InstrumentationProbeResult,
  }
}

function completeConfig(sqlitePath: string) {
  const defaults = createDefaultConfig()
  return {
    ...defaults,
    setup: { completed: true, completedAt: "2026-08-11T00:00:00.000Z" },
    database: {
      ...defaults.database,
      driver: "sqlite" as const,
      sqlite: { ...defaults.database.sqlite, path: sqlitePath },
    },
    auth: {
      ...defaults.auth,
      secret: "cold-auth-secret-abcdefghijklmnopqrstuvwxyz-1234",
      passwordPepper: "cold-password-pepper-abcdefghijklmnopqrstuvwxyz",
    },
    email: {
      ...defaults.email,
      ingestSecret: "cold-ingest-secret-abcdefghijklmnopqrstuvwxyz-12",
    },
  }
}

try {
  const invalidRoot = join(temporaryRoot, "invalid-primary")
  mkdirSync(join(invalidRoot, "data"), { recursive: true })
  writeFileSync(
    join(invalidRoot, "data/config.yaml"),
    stringifyConfig(completeConfig(".")),
    "utf8",
  )
  const invalid = runProbe(invalidRoot)
  assert.equal(invalid.before.setupCompleted, false)
  assert.equal(invalid.after.setupCompleted, false)
  assert.equal(invalid.reload.ok, false)
  assert.ok(invalid.after.fatal?.length)

  execFileSync(process.execPath, [
    tsxCli,
    resolve(repositoryRoot, "scripts/database/startup.ts"),
  ], { cwd: invalidRoot, stdio: "pipe" })
  execFileSync(process.execPath, [
    tsxCli,
    resolve(repositoryRoot, "scripts/validate-config.ts"),
  ], { cwd: invalidRoot, stdio: "pipe" })
  assert.equal(existsSync(join(invalidRoot, "data/setup-token")), true)

  const emptyOwnerRoot = join(temporaryRoot, "empty-owner")
  mkdirSync(join(emptyOwnerRoot, "data"), { recursive: true })
  cpSync(
    resolve(repositoryRoot, "drizzle-local"),
    join(emptyOwnerRoot, "drizzle-local"),
    { recursive: true },
  )
  execFileSync(process.execPath, [tsxCli, setupProbeScript, "normal"], {
    cwd: emptyOwnerRoot,
    stdio: "pipe",
  })
  cpSync(
    join(emptyOwnerRoot, "data/setup.db"),
    join(emptyOwnerRoot, "data/empty-owner.db"),
  )
  const ownerlessDatabase = new Database(join(emptyOwnerRoot, "data/empty-owner.db"))
  ownerlessDatabase.prepare("DELETE FROM user_role").run()
  ownerlessDatabase.close()
  const emptyOwnerYaml = stringifyConfig(completeConfig("data/empty-owner.db"))
  writeFileSync(join(emptyOwnerRoot, "data/config.yaml"), emptyOwnerYaml, "utf8")
  writeFileSync(join(emptyOwnerRoot, "data/config.yaml.lkg"), emptyOwnerYaml, "utf8")
  const emptyOwner = runProbe(emptyOwnerRoot)
  assert.equal(emptyOwner.unverifiedGetConfigRejected, true)
  assert.equal(emptyOwner.after.setupCompleted, false)
  assert.equal(emptyOwner.reload.ok, false)
  assert.match(
    emptyOwner.after.fatal?.map(issue => issue.message).join(" ") ?? "",
    /没有站主账号/,
  )
  assert.deepEqual(emptyOwner.recoveryCandidate, {
    setupCompleted: true,
    passwordPepperPresent: true,
  })

  const emptyLkgRoot = join(temporaryRoot, "missing-primary-empty-owner-lkg")
  mkdirSync(join(emptyLkgRoot, "data"), { recursive: true })
  cpSync(
    resolve(repositoryRoot, "drizzle-local"),
    join(emptyLkgRoot, "drizzle-local"),
    { recursive: true },
  )
  cpSync(
    join(emptyOwnerRoot, "data/empty-owner.db"),
    join(emptyLkgRoot, "data/recovered.db"),
  )
  writeFileSync(
    join(emptyLkgRoot, "data/config.yaml.lkg"),
    stringifyConfig(completeConfig("data/recovered.db")),
    "utf8",
  )
  const emptyLkg = runProbe(emptyLkgRoot)
  assert.equal(emptyLkg.before.setupCompleted, false)
  assert.equal(emptyLkg.after.setupCompleted, false)
  assert.ok(emptyLkg.after.fatal?.length)

  const validLkgRoot = join(temporaryRoot, "missing-primary-valid-owner-lkg")
  mkdirSync(join(validLkgRoot, "data"), { recursive: true })
  cpSync(
    resolve(repositoryRoot, "drizzle-local"),
    join(validLkgRoot, "drizzle-local"),
    { recursive: true },
  )
  execFileSync(process.execPath, [tsxCli, setupProbeScript, "normal"], {
    cwd: validLkgRoot,
    stdio: "pipe",
  })
  rmSync(join(validLkgRoot, "data/config.yaml"), { force: true })
  const recovered = runProbe(validLkgRoot)
  assert.equal(recovered.unverifiedGetConfigRejected, true)
  assert.equal(recovered.before.setupCompleted, false)
  assert.equal(recovered.before.fileExists, false)
  assert.equal(recovered.after.loadedFromFile, true)
  assert.equal(recovered.after.setupCompleted, true)
  assert.equal(recovered.activeDriver, "sqlite")
  assert.equal(recovered.boundDriver, "sqlite")
  assert.equal(recovered.databaseOpened, true)

  const pairedSnapshot = readFileSync(
    join(validLkgRoot, "data/config.yaml.lkg"),
    "utf8",
  )
  const parsedSnapshot = parseConfig(parseConfigDocument(pairedSnapshot))
  assert.equal(parsedSnapshot.ok, true)
  if (!parsedSnapshot.ok) throw new Error("validated LKG could not be parsed")
  const invalidPostgresPrimary = {
    ...parsedSnapshot.config,
    database: {
      ...parsedSnapshot.config.database,
      driver: "postgres" as const,
      postgres: {
        ...parsedSnapshot.config.database.postgres,
        url: "postgresql://moemail@127.0.0.1:1/moemail",
        connectTimeoutMs: 1_000,
      },
    },
  }
  writeFileSync(
    join(validLkgRoot, "data/config.yaml"),
    stringifyConfig(invalidPostgresPrimary),
    "utf8",
  )
  const crossDriverFallback = runProbe(validLkgRoot)
  assert.equal(crossDriverFallback.unverifiedGetConfigRejected, true)
  assert.equal(crossDriverFallback.after.setupCompleted, true)
  assert.equal(crossDriverFallback.activeDriver, "sqlite")
  assert.equal(crossDriverFallback.boundDriver, "sqlite")
  assert.equal(crossDriverFallback.databaseOpened, true)
  assert.ok(crossDriverFallback.after.lastError?.issues.length)

  // instrumentation 只能等待 ensureState 已经排队的 boot 校验；若随后再强制
  // reload，同一个无响应 PG primary 会连续吃掉两次 connect timeout。
  const blackholeSockets = new Set<import("node:net").Socket>()
  const blackhole = createServer(socket => {
    blackholeSockets.add(socket)
    socket.once("close", () => blackholeSockets.delete(socket))
  })
  await new Promise<void>((resolvePromise, rejectPromise) => {
    blackhole.once("error", rejectPromise)
    blackhole.listen(0, "127.0.0.1", resolvePromise)
  })
  try {
    const address = blackhole.address()
    assert.ok(address && typeof address === "object")
    writeFileSync(
      join(validLkgRoot, "data/config.yaml"),
      stringifyConfig({
        ...invalidPostgresPrimary,
        database: {
          ...invalidPostgresPrimary.database,
          postgres: {
            ...invalidPostgresPrimary.database.postgres,
            url: `postgresql://moemail@127.0.0.1:${address.port}/moemail`,
          },
        },
      }),
      "utf8",
    )
    const instrumentation = runInstrumentationProbe(validLkgRoot, "instrumentation")
    assert.equal(instrumentation.result.mode, "instrumentation")
    assert.equal(instrumentation.result.status.bootCandidatePending, false)
    assert.equal(instrumentation.result.status.setupCompleted, true)
    assert.equal(instrumentation.result.activeDriver, "sqlite")
    assert.equal(instrumentation.result.boundDriver, "sqlite")
    assert.equal(instrumentation.result.databaseOpened, true)
    assert.ok(instrumentation.result.elapsedMs >= 800)
    assert.equal(
      instrumentation.output.match(/"trigger":"boot-primary"/g)?.length ?? 0,
      1,
    )
    assert.equal(
      instrumentation.output.match(/"trigger":"manual"/g)?.length ?? 0,
      0,
    )

    const maintenance = runInstrumentationProbe(validLkgRoot, "maintenance")
    assert.equal(maintenance.result.mode, "maintenance")
    assert.equal(maintenance.result.status.bootCandidatePending, false)
    assert.equal(maintenance.result.status.setupCompleted, true)
    assert.equal(maintenance.result.activeDriver, "sqlite")
    assert.equal(maintenance.result.boundDriver, "sqlite")
    assert.equal(maintenance.result.databaseOpened, true)
    assert.ok(maintenance.result.elapsedMs >= 800)
    assert.equal(
      maintenance.output.match(/"trigger":"boot-primary"/g)?.length ?? 0,
      1,
    )
    assert.equal(
      maintenance.output.match(/"trigger":"manual"/g)?.length ?? 0,
      0,
    )
  } finally {
    for (const socket of blackholeSockets) socket.destroy()
    await new Promise<void>(resolvePromise => blackhole.close(() => resolvePromise()))
  }

  console.log(JSON.stringify({
    unverifiedBootCandidateNotReadable: true,
    untrustedColdConfigValidatedBeforeApply: true,
    invalidColdConfigKeepsWebRecoveryBootable: true,
    completedConfigWithoutOwnerRejected: true,
    matchingPrimaryAndLkgOwnerRevalidated: true,
    fatalDatabaseRecoveryPreservesSecrets: true,
    missingPrimaryLkgOwnerRevalidated: true,
    missingPrimaryRecoveredFromValidatedLastKnownGood: true,
    crossDriverFallbackBindsValidatedLkg: true,
    instrumentationAwaitsBootValidationWithoutRetry: true,
    maintenanceAwaitsBootValidationWithoutRetry: true,
  }, null, 2))
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
