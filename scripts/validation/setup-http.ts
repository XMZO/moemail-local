import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parse, stringify } from "yaml"
import { stringifyConfig } from "../../app/lib/config/file"
import { createDefaultConfig } from "../../app/lib/config/schema"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-setup-http-"))
const nextCli = resolve(repositoryRoot, "node_modules/next/dist/bin/next")
const adminUsername = "http-owner"
const adminPassword = "http-owner-password-123456"
const postgresUrl = process.argv
  .find(argument => argument.startsWith("--postgres-url="))
  ?.slice("--postgres-url=".length) ?? null
const expectedDriver = postgresUrl ? "postgres" : "sqlite"
const stagedRedactionProbe = process.argv.includes("--staged-lkg-redaction")
const stagedRcloneSecret = "staged-rclone-secret-must-not-appear-in-setup-html"

class CookieJar {
  private readonly values = new Map<string, string>()

  apply(headers: Headers) {
    if (this.values.size > 0) {
      headers.set("Cookie", [...this.values].map(([name, value]) => `${name}=${value}`).join("; "))
    }
  }

  absorb(headers: Headers) {
    const setCookies = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter((value): value is string => Boolean(value))
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";", 1)
      const separator = pair.indexOf("=")
      if (separator <= 0) continue
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (/max-age=0/i.test(setCookie) || !value) this.values.delete(name)
      else this.values.set(name, value)
    }
  }
}

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

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read().catch(() => null)
    if (value !== null) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>(resolvePromise => child.once("exit", () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

let server: ChildProcess | null = null
let stdout = ""
let stderr = ""
let setupToken = ""

function launchServer(port: number) {
  const child = spawn(process.execPath, [
    nextCli,
    "start",
    ".",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: temporaryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", chunk => { stdout += String(chunk) })
  child.stderr?.on("data", chunk => { stderr += String(chunk) })
  return child
}

try {
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(temporaryRoot, "drizzle-local"), {
    recursive: true,
  })
  cpSync(resolve(repositoryRoot, "drizzle-postgres"), join(temporaryRoot, "drizzle-postgres"), {
    recursive: true,
  })
  for (const directory of [".next", "node_modules", "public"]) {
    symlinkSync(
      resolve(repositoryRoot, directory),
      join(temporaryRoot, directory),
      "junction",
    )
  }
  for (const file of ["package.json", "next.config.ts", "next-intl.config.ts", "tsconfig.json"]) {
    cpSync(resolve(repositoryRoot, file), join(temporaryRoot, file))
  }
  if (stagedRedactionProbe) {
    mkdirSync(join(temporaryRoot, "data"), { recursive: true })
    const defaults = createDefaultConfig()
    writeFileSync(join(temporaryRoot, "data/config.yaml.lkg"), stringifyConfig({
      ...defaults,
      offsite: {
        ...defaults.offsite,
        rcloneConfigContent: `[archive]\ntype = local\nsecret = ${stagedRcloneSecret}`,
      },
    }), "utf8")
  }

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  server = launchServer(port)

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/internal/health`)
    if (!response.ok) return null
    const body = await response.json() as { status?: string }
    return body.status === "setup-required" ? body : null
  })

  const root = await fetch(`${baseUrl}/zh-CN`, { redirect: "manual" })
  assert.equal(root.status, 307)
  assert.equal(new URL(root.headers.get("location") as string, baseUrl).pathname, "/zh-CN/setup")

  const setupPage = await fetch(`${baseUrl}/zh-CN/setup`)
  assert.equal(setupPage.status, 200)
  const setupHtml = await setupPage.text()
  assert.match(setupHtml, /MoeMail/)
  if (stagedRedactionProbe) {
    assert.doesNotMatch(setupHtml, new RegExp(stagedRcloneSecret))
    assert.match(setupHtml, /Existing advanced values are preserved/)

    // 覆盖 LKG 随后丢失、runtime 仅保留已验证内存配置的边界；匿名页面仍
    // 不得把 staged secret 当作 fresh defaults 序列化出来。
    rmSync(join(temporaryRoot, "data/config.yaml"), { force: true })
    rmSync(join(temporaryRoot, "data/config.yaml.lkg"), { force: true })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_200))
    const memoryOnlySetupPage = await fetch(`${baseUrl}/zh-CN/setup`)
    assert.equal(memoryOnlySetupPage.status, 200)
    const memoryOnlyHtml = await memoryOnlySetupPage.text()
    assert.doesNotMatch(memoryOnlyHtml, new RegExp(stagedRcloneSecret))
    assert.match(memoryOnlyHtml, /Existing advanced values are preserved/)
  } else {
    assert.match(setupHtml, /rcloneConfigContent/)
  }

  const tokenPath = join(temporaryRoot, "data/setup-token")
  setupToken = await waitFor(async () => (
    existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : null
  ))
  assert.ok(setupToken.length >= 32)

  const sharedBeforeSetup = await fetch(`${baseUrl}/api/shared/not-a-token`)
  assert.equal(sharedBeforeSetup.status, 503)
  assert.equal((await sharedBeforeSetup.json() as { code?: string }).code, "SETUP_REQUIRED")

  const setupPayload = {
    config: {
      server: { baseUrl, emailPollIntervalMs: 27_000 },
      database: postgresUrl
        ? { driver: "postgres", postgres: { url: postgresUrl } }
        : { driver: "sqlite", sqlite: { path: "data/http-setup.db" } },
    },
    advancedYaml: stagedRedactionProbe ? "# preserve staged advanced values\n" : [
      "scheduler:",
      "  cleanupIntervalSeconds: 120",
      "monitor:",
      "  intervalSeconds: 60",
      "offsite:",
      "  intervalSeconds: 180",
      "  rcloneConfigContent: null",
      "",
    ].join("\n"),
  }

  const deniedProbe = await fetch(`${baseUrl}/api/setup/database`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setupPayload),
  })
  assert.equal(deniedProbe.status, 401)

  const acceptedProbe = await fetch(`${baseUrl}/api/setup/database`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MoeMail-Setup-Token": setupToken,
    },
    body: JSON.stringify(setupPayload),
  })
  assert.equal(acceptedProbe.status, 200)

  const completed = await fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MoeMail-Setup-Token": setupToken,
    },
    body: JSON.stringify({
      ...setupPayload,
      admin: { username: adminUsername, password: adminPassword },
    }),
  })
  assert.equal(completed.status, 200)
  const completedBody = await completed.json() as {
    ok?: boolean
    emailIngestSecret?: string
    restartRequired?: string | null
  }
  assert.equal(completedBody.ok, true)
  assert.ok((completedBody.emailIngestSecret?.length ?? 0) >= 32)
  assert.equal(Boolean(completedBody.restartRequired), Boolean(postgresUrl))
  assert.equal(existsSync(tokenPath), false)

  const configPath = join(temporaryRoot, "data/config.yaml")
  assert.equal(existsSync(configPath), true)
  assert.equal(existsSync(`${configPath}.lkg`), true)
  if (stagedRedactionProbe) {
    assert.match(readFileSync(configPath, "utf8"), new RegExp(stagedRcloneSecret))
  }

  if (postgresUrl) {
    await waitFor(async () => (
      server?.exitCode !== null || server?.signalCode !== null ? true : null
    ), 8_000)
    assert.equal(server.exitCode, 0)
    server = launchServer(port)
  }

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/internal/health`)
    const body = await response.json() as { status?: string; database?: string }
    return response.ok && body.status === "ok" && body.database === expectedDriver ? body : null
  })

  const setupClosed = await fetch(`${baseUrl}/api/setup`, {
    headers: { "X-MoeMail-Setup-Token": setupToken },
  })
  assert.equal(setupClosed.status, 409)

  const jar = new CookieJar()
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    jar.apply(headers)
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      redirect: init.redirect ?? "manual",
    })
    jar.absorb(response.headers)
    return response
  }

  const csrfResponse = await request("/api/auth/csrf")
  assert.equal(csrfResponse.status, 200)
  const { csrfToken } = await csrfResponse.json() as { csrfToken: string }
  assert.ok(csrfToken)

  const login = await request("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken,
      username: adminUsername,
      password: adminPassword,
      callbackUrl: `${baseUrl}/zh-CN`,
    }),
  })
  assert.ok([302, 303].includes(login.status))

  const sessionResponse = await request("/api/auth/session")
  assert.equal(sessionResponse.status, 200)
  const session = await sessionResponse.json() as {
    user?: { username?: string; roles?: Array<{ name?: string }> }
  }
  assert.equal(session.user?.username, adminUsername)
  assert.ok(session.user?.roles?.some(role => role.name === "emperor"))

  const runtimeResponse = await request("/api/runtime-config")
  assert.equal(runtimeResponse.status, 200)
  const runtimeBody = await runtimeResponse.json() as { yaml: string; fingerprint: string }
  const webConfig = parse(runtimeBody.yaml) as Record<string, any>
  webConfig.server.emailPollIntervalMs = 29_000
  const webYaml = stringify(webConfig, { lineWidth: 0 })

  const webSave = await request("/api/runtime-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml: webYaml, fingerprint: runtimeBody.fingerprint }),
  })
  assert.equal(webSave.status, 200)

  const staleSave = await request("/api/runtime-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml: webYaml, fingerprint: runtimeBody.fingerprint }),
  })
  assert.equal(staleSave.status, 409)

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/runtime-config/public`)
    const body = await response.json() as { config?: { emailPollIntervalMs?: number } }
    return body.config?.emailPollIntervalMs === 29_000 ? body : null
  })

  const directConfig = parse(readFileSync(configPath, "utf8")) as Record<string, any>
  directConfig.server.emailPollIntervalMs = 31_000
  const validDirectYaml = stringify(directConfig, { lineWidth: 0 })
  writeFileSync(configPath, validDirectYaml, "utf8")
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/runtime-config/public`)
    const body = await response.json() as { config?: { emailPollIntervalMs?: number } }
    return body.config?.emailPollIntervalMs === 31_000 ? body : null
  }, 8_000)

  const healthSecretCanary = "HEALTH-SECRET-CANARY-abcdefghijklmnopqrstuvwxyz-0123456789"
  writeFileSync(configPath, `auth:\n  secret: [${healthSecretCanary}\n`, "utf8")
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/internal/health`)
    const raw = await response.text()
    assert.doesNotMatch(raw, new RegExp(healthSecretCanary))
    const body = JSON.parse(raw) as { configError?: unknown }
    return response.ok && body.configError ? body : null
  }, 8_000)

  const publicAfterInvalid = await fetch(`${baseUrl}/api/runtime-config/public`)
  assert.equal(publicAfterInvalid.status, 200)
  assert.equal(
    (await publicAfterInvalid.json() as { config: { emailPollIntervalMs: number } })
      .config.emailPollIntervalMs,
    31_000,
  )

  writeFileSync(configPath, validDirectYaml, "utf8")
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/internal/health`)
    const body = await response.json() as { status?: string; configError?: unknown }
    return response.ok && body.status === "ok" && !body.configError ? body : null
  }, 8_000)

  console.log(JSON.stringify({
    firstRunRedirectsToWebUi: true,
    setupTokenGate: true,
    databaseProbeAndSetup: true,
    uniqueEmperorLogin: true,
    webUiYamlSaveApplied: true,
    staleWebUiSaveRejected: true,
    directFileHotReloadApplied: true,
    invalidFileKeptPreviousConfig: true,
    setupAndSharedApisGated: true,
    databaseDriver: expectedDriver,
    driverRestartRecovered: Boolean(postgresUrl),
    stagedLkgSecretsRedactedAndPreserved: stagedRedactionProbe,
    stagedMemoryOnlySecretsRedacted: stagedRedactionProbe,
    publicHealthConfigErrorsRedacted: true,
  }, null, 2))
} catch (error) {
  const sanitized = `${stdout}\n${stderr}`
    .replace(/"token":"[^"]+"/g, '"token":"[redacted]"')
    .replace(setupToken, "[redacted]")
  console.error(sanitized.slice(-4_000))
  throw error
} finally {
  if (server) await stop(server)
  rmSync(temporaryRoot, { recursive: true, force: true })
}
