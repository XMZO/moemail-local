import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-maintenance-bundle-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const setupProbe = resolve(repositoryRoot, "scripts/validation/setup-recovery-probe.ts")
const bundle = resolve(repositoryRoot, ".next/maintenance/maintenance.mjs")
const bundledConfigReader = resolve(repositoryRoot, ".next/maintenance/config-reader.cjs")

function run(command: string, ...arguments_: string[]) {
  return execFileSync(process.execPath, [bundle, command, ...arguments_], {
    cwd: temporaryRoot,
    encoding: "utf8",
  })
}

try {
  mkdirSync(join(temporaryRoot, "data/backups"), { recursive: true })
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(temporaryRoot, "drizzle-local"), {
    recursive: true,
  })
  execFileSync(process.execPath, [tsxCli, setupProbe, "normal"], {
    cwd: temporaryRoot,
    encoding: "utf8",
  })

  const lastKnownGood = join(temporaryRoot, "data/config.yaml.lkg")
  assert.equal(execFileSync(process.execPath, [
    bundledConfigReader, "--file", lastKnownGood, "state",
  ], { encoding: "utf8" }), "ready")
  assert.equal(execFileSync(process.execPath, [
    bundledConfigReader, "--file", lastKnownGood, "get", "database.driver",
  ], { encoding: "utf8" }), "sqlite")

  const selfCheck = run("self-check")
  assert.match(selfCheck, /"maintenance":"ready"/)
  assert.match(selfCheck, /"sqliteNativeBinding":true/)
  assert.match(run("migrate"), /"driver":"sqlite"/)
  assert.match(run("verify"), /"driver":"sqlite"/)
  const backupOutput = run("backup")
  assert.match(backupOutput, /"event":"sqlite\.backup\.ok"/)
  run("cleanup")

  const backups = readdirSync(join(temporaryRoot, "data/backups"))
    .filter(name => /^moemail-.+\.db$/.test(name))
  assert.equal(backups.length, 1)
  assert.equal(
    existsSync(join(temporaryRoot, "data/backups", `${backups[0]}.config.yaml.lkg`)),
    true,
  )
  const backup = join(temporaryRoot, "data/backups", backups[0])
  assert.match(run("restore", backup, "--force"), /"event":"sqlite\.restore\.ok"/)
  assert.match(run("verify"), /"driver":"sqlite"/)

  console.log(JSON.stringify({
    bundleSelfCheck: true,
    sqliteNativeBinding: true,
    bundledConfigReader: true,
    sqliteVerify: true,
    sqliteMigrate: true,
    sqliteBackupPair: true,
    sqliteRestore: true,
    sqliteCleanup: true,
  }, null, 2))
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
