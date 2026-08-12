import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Pool } from "pg"
import { verifyPostgres } from "../postgres/lib"

const repositoryRoot = process.cwd()
const clusterRoot = mkdtempSync(join(tmpdir(), "moemail-setup-http-postgres-"))
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs")
const httpValidation = resolve(repositoryRoot, "scripts/validation/setup-http.ts")
const imapValidation = resolve(repositoryRoot, "scripts/validation/imap-inbound.ts")
let started = false

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolvePromise())
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const port = address.port
  await new Promise<void>((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise())
  })
  return port
}

try {
  execFileSync(process.execPath, [
    resolve(repositoryRoot, "scripts/build-maintenance.mjs"),
  ], { cwd: repositoryRoot, stdio: "inherit" })

  const port = await freePort()
  execFileSync("initdb", [
    "--pgdata", clusterRoot,
    "--username", "postgres",
    "--auth", "trust",
    "--encoding", "UTF8",
    "--no-locale",
  ], { stdio: "pipe" })
  execFileSync("pg_ctl", [
    "--pgdata", clusterRoot,
    "--options", `-h 127.0.0.1 -p ${port}`,
    "--log", join(clusterRoot, "postgres.log"),
    "--wait",
    "start",
  ], { stdio: "ignore" })
  started = true

  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`
  execFileSync(process.execPath, [
    tsxCli,
    httpValidation,
    `--postgres-url=${url}`,
    "--verify-maintenance-bundle",
  ], {
    cwd: repositoryRoot,
    stdio: "inherit",
  })
  execFileSync("psql", [
    "--dbname", url,
    "--file", resolve(repositoryRoot, "deploy/docker/postgres-verify.sql"),
  ], {
    cwd: repositoryRoot,
    stdio: "inherit",
  })

  execFileSync("psql", [
    "--dbname", url,
    "--command", "CREATE DATABASE moemail_imap_validation",
  ], { stdio: "pipe" })
  const imapUrl = new URL(url)
  imapUrl.pathname = "/moemail_imap_validation"
  execFileSync(process.execPath, [
    tsxCli,
    imapValidation,
    `--postgres-url=${imapUrl.toString()}`,
  ], {
    cwd: repositoryRoot,
    stdio: "inherit",
  })
  const verificationPool = new Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    password: async () => "",
  })
  try {
    const verification = await verifyPostgres(verificationPool)
    assert.equal(verification.securityInvariants.emperorUsers, 1)
    execFileSync("psql", [
      "--dbname", url,
      "--command",
      'DROP INDEX public.name_user_id_unique; CREATE INDEX name_user_id_unique ON public.api_keys (name, user_id)',
    ], { stdio: "pipe" })
    await assert.rejects(
      verifyPostgres(verificationPool),
      /index name_user_id_unique is missing or invalid/,
    )
    const rejectedDockerVerification = spawnSync("psql", [
      "--dbname", url,
      "--file", resolve(repositoryRoot, "deploy/docker/postgres-verify.sql"),
    ], { encoding: "utf8" })
    assert.notEqual(rejectedDockerVerification.status, 0)
    assert.match(
      rejectedDockerVerification.stderr,
      /missing or invalid indexes/,
    )
  } finally {
    await verificationPool.end()
  }

  console.log(JSON.stringify({
    temporaryPostgresCluster: true,
    postgresSetupAndDriverRestartHttp: true,
    postgresPoolMaxOneImapLease: true,
    dockerPostgresVerifier: true,
    postgresVerifierRejectsIndexDefinitionTampering: true,
    postgresMaintenanceBundle: true,
  }, null, 2))
} finally {
  if (started) {
    try {
      execFileSync("pg_ctl", [
        "--pgdata", clusterRoot,
        "--mode", "fast",
        "--wait",
        "stop",
      ], { stdio: "pipe" })
    } catch (error) {
      console.error(`failed to stop temporary PostgreSQL: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  rmSync(clusterRoot, { recursive: true, force: true })
}
