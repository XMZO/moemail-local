import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stringifyConfig } from "../../app/lib/config/file"
import { createDefaultConfig } from "../../app/lib/config/schema"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-runtime-scheduler-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const scheduler = resolve(repositoryRoot, "scripts/ops/runtime-scheduler.ts")
const lkgPath = join(temporaryRoot, "data/config.yaml.lkg")

try {
  mkdirSync(join(temporaryRoot, "data"), { recursive: true })
  const defaults = createDefaultConfig()
  const readyConfig = {
    ...defaults,
    setup: { completed: true, completedAt: new Date().toISOString() },
    auth: {
      ...defaults.auth,
      secret: "scheduler-auth-secret-abcdefghijklmnopqrstuvwxyz",
      passwordPepper: "scheduler-password-pepper-abcdefghijklmnopqrstuvwxyz",
    },
    email: {
      ...defaults.email,
      ingestSecret: "scheduler-ingest-secret-abcdefghijklmnopqrstuvwxyz",
    },
  }
  writeFileSync(lkgPath, stringifyConfig(readyConfig), "utf8")
  writeFileSync(join(temporaryRoot, "data/config.yaml"), "broken: [\n", "utf8")

  const readyOutput = execFileSync(process.execPath, [tsxCli, scheduler, "--check"], {
    cwd: temporaryRoot,
    encoding: "utf8",
  })
  assert.match(readyOutput, /"ready":true/)

  writeFileSync(lkgPath, "setup:\n  completed: true\nunknownField: true\n", "utf8")
  const invalid = spawnSync(process.execPath, [tsxCli, scheduler, "--check"], {
    cwd: temporaryRoot,
    encoding: "utf8",
  })
  assert.equal(invalid.status, 75)
  assert.match(invalid.stdout, /"ready":false/)

  console.log(JSON.stringify({
    schedulerReadsValidatedLkgOnly: true,
    invalidLkgRejected: true,
  }, null, 2))
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
