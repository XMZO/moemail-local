import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
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
const verifyMaintenanceBundle = process.argv.includes("--verify-maintenance-bundle")
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

async function verifyCompressedFontAsset(baseUrl: string, html: string) {
  const cssPaths = [...html.matchAll(/href="([^"]+\.css(?:\?[^"]*)?)"/g)]
    .map(match => match[1])
  assert.ok(cssPaths.length > 0, "setup page must link at least one stylesheet")

  const stylesheets = await Promise.all(cssPaths.map(async path => {
    const response = await fetch(new URL(path, baseUrl))
    assert.equal(response.status, 200)
    return response.text()
  }))
  const fontPath = stylesheets.join("\n")
    .match(/\/_next\/static\/media\/[^)"']+\.woff2/)?.[0]
  assert.ok(fontPath, "built CSS must reference the compressed WOFF2 font")

  const response = await fetch(new URL(fontPath, baseUrl))
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /woff2/i)
  const bytes = (await response.arrayBuffer()).byteLength
  assert.ok(bytes > 0 && bytes < 1_000_000, "served WOFF2 font must stay below 1 MB")
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
  await verifyCompressedFontAsset(baseUrl, setupHtml)
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

  const mailTestBeforeSetup = await fetch(`${baseUrl}/api/config/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "imap", policy: {} }),
  })
  assert.equal(mailTestBeforeSetup.status, 503)

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
    user?: {
      id?: string
      username?: string
      roles?: Array<{ name?: string }>
      permissions?: string[]
      quotas?: Record<string, number>
    }
  }
  assert.equal(session.user?.username, adminUsername)
  assert.ok(session.user?.roles?.some(role => role.name === "emperor"))
  assert.ok(session.user?.permissions?.includes("manage_config"))
  assert.equal(session.user?.quotas?.dailySendLimit, 0)

  const unauthenticatedMailTest = await fetch(`${baseUrl}/api/config/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "imap", policy: {} }),
  })
  assert.equal(unauthenticatedMailTest.status, 401)

  const validationMarker = "mail-connection-secret-must-not-echo"
  const invalidMailTest = await request("/api/config/domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "imap",
      policy: {
        mode: "imap",
        host: "bad host",
        port: 993,
        security: "tls",
        username: "test-user",
        password: validationMarker,
        rejectUnauthorized: true,
        mailbox: "INBOX",
        recipientHeader: "auto",
        initialSync: "new",
        pollIntervalSeconds: 60,
        maxMessagesPerPoll: 100,
      },
    }),
  })
  assert.equal(invalidMailTest.status, 400)
  assert.doesNotMatch(await invalidMailTest.text(), new RegExp(validationMarker))

  const domainPoliciesResponse = await request("/api/config/domains")
  assert.equal(domainPoliciesResponse.status, 200)
  const validationDomain = "http-validation.example"
  const saveDomainPolicies = await request("/api/config/domains", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      policies: [{
        domain: validationDomain,
        inbound: { mode: "worker" },
        outbound: { mode: "disabled" },
      }],
    }),
  })
  assert.equal(saveDomainPolicies.status, 200)

  const createMailbox = await request("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "setup-http",
      domain: validationDomain,
      expiryTime: 3_600_000,
    }),
  })
  assert.equal(createMailbox.status, 200)
  const mailbox = await createMailbox.json() as { id: string; email: string }
  assert.equal(mailbox.email, `setup-http@${validationDomain}`)

  const rawMessage = Buffer.from([
    "From: sender@example.net",
    `To: ${mailbox.email}`,
    "Subject: setup HTTP ingestion",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "mail policy integration marker",
  ].join("\r\n"))
  const ingest = await fetch(`${baseUrl}/api/internal/email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${completedBody.emailIngestSecret}`,
      "Content-Type": "message/rfc822",
      "X-MoeMail-Envelope-From": "sender@example.net",
      "X-MoeMail-Envelope-To": mailbox.email,
      "X-MoeMail-Raw-Size": String(rawMessage.byteLength),
    },
    body: rawMessage,
  })
  assert.equal(ingest.status, 201)
  assert.equal((await ingest.json() as { status?: string }).status, "created")

  const receivedMessages = await request(`/api/emails/${mailbox.id}?includeTotal=1`)
  assert.equal(receivedMessages.status, 200)
  assert.equal((await receivedMessages.json() as { total?: number }).total, 1)

  const sendPermission = await request(`/api/emails/send-permission?emailId=${mailbox.id}`)
  assert.equal(sendPermission.status, 200)
  assert.equal((await sendPermission.json() as { canSend?: boolean }).canSend, false)

  const accessPoliciesResponse = await request("/api/access-policies")
  assert.equal(accessPoliciesResponse.status, 200)
  const accessPoliciesBody = await accessPoliciesResponse.json() as {
    policies: { roles: unknown }
  }
  const saveRolePolicies = await request("/api/access-policies", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles: accessPoliciesBody.policies.roles }),
  })
  assert.equal(saveRolePolicies.status, 200)

  assert.ok(session.user?.id)
  const mutateEmperorAccess = await request(
    `/api/access-policies/users/${encodeURIComponent(session.user!.id!)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: { manage_config: false }, quotas: {} }),
    },
  )
  assert.equal(mutateEmperorAccess.status, 400)

  const appearance = await request("/api/config/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fontFamily: "system-ui, sans-serif" }),
  })
  assert.equal(appearance.status, 200)
  assert.equal((await appearance.json() as { fontFamily?: string }).fontFamily, "system-ui, sans-serif")
  const unsafeAppearance = await request("/api/config/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fontFamily: "url(https://attacker.invalid/font)" }),
  })
  assert.equal(unsafeAppearance.status, 400)

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

  let maintenanceBundleVerified = false
  if (verifyMaintenanceBundle) {
    const maintenanceBundle = resolve(repositoryRoot, ".next/maintenance/maintenance.mjs")
    const migrateOutput = execFileSync(process.execPath, [maintenanceBundle, "migrate"], {
      cwd: temporaryRoot,
      encoding: "utf8",
    })
    assert.match(migrateOutput, new RegExp(`"driver":"${expectedDriver}"`))
    const verifyOutput = execFileSync(process.execPath, [maintenanceBundle, "verify"], {
      cwd: temporaryRoot,
      encoding: "utf8",
    })
    assert.match(verifyOutput, new RegExp(`"driver":"${expectedDriver}"`))
    maintenanceBundleVerified = true
  }

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
    mailConnectionTestAuthAndRedaction: true,
    domainPolicyAndWorkerIngestion: true,
    independentOutboundDisable: true,
    emperorAccessImmutable: true,
    appearanceValidation: true,
    compressedFontAsset: true,
    maintenanceBundleVerified,
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
