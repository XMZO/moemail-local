import assert from "node:assert/strict"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import type { Socket } from "node:net"
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
import Database from "better-sqlite3"
import { Pool } from "pg"
import { stringifyConfig } from "../../app/lib/config/file"
import { createDefaultConfig } from "../../app/lib/config/schema"
import { parsePostgresConnectionUrl } from "../../app/lib/postgres-connection"

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

type DomainAccessMode = "allow" | "receive" | "send" | "deny"
type MailDirection = "send" | "receive"
type MailQuotaRule = { limit: number; windowValue: number; windowUnit: "second" | "minute" | "hour" | "day" | "week" | "month" }
type RoleAccessPolicy = {
  permissions: Record<string, boolean>
  quotas: { maxActiveMailboxes: number; maxMailboxLifetimeDays: number; maxMessageBytes: number }
  domainAccess: { default: DomainAccessMode; domains: Record<string, DomainAccessMode> }
}
type MailQuotaAssignment = { id: string; direction: "send" | "receive"; subject: { type: "all" } | { type: "role"; role: string } | { type: "user"; userId: string }; target: { type: "all" } | { type: "domain"; domain: string } | { type: "mailbox"; address: string }; rolling: MailQuotaRule; lifetimeLimit: number; shareWithinRole: boolean; ignoreEmperor: boolean }

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

async function startSmtpSink() {
  const messages: string[] = []
  const sockets = new Set<Socket>()
  const smtp = createServer(socket => {
    sockets.add(socket)
    socket.setEncoding("utf8")
    socket.on("close", () => sockets.delete(socket))
    socket.write("220 setup-http.example ESMTP\r\n")
    let input = ""
    let data = ""
    let receivingData = false
    socket.on("data", chunk => {
      input += chunk
      while (true) {
        const end = input.indexOf("\r\n")
        if (end < 0) break
        const line = input.slice(0, end)
        input = input.slice(end + 2)
        if (receivingData) {
          if (line === ".") {
            receivingData = false
            messages.push(data)
            data = ""
            socket.write("250 queued\r\n")
          } else {
            data += `${line}\r\n`
          }
        } else if (/^EHLO /iu.test(line)) {
          socket.write("250-setup-http.example\r\n250 OK\r\n")
        } else if (/^DATA$/iu.test(line)) {
          receivingData = true
          socket.write("354 end with dot\r\n")
        } else if (/^QUIT$/iu.test(line)) {
          socket.end("221 bye\r\n")
        } else {
          socket.write("250 ok\r\n")
        }
      }
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    smtp.once("error", reject)
    smtp.listen(0, "127.0.0.1", resolvePromise)
  })
  const address = smtp.address()
  assert.ok(address && typeof address === "object")
  return {
    messages,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolvePromise => smtp.close(() => resolvePromise()))
    },
  }
}

async function expireMailbox(mailboxId: string) {
  const expiresAt = new Date(Date.now() - 60_000)
  if (postgresUrl) {
    const target = parsePostgresConnectionUrl(postgresUrl)
    const pool = new Pool({
      host: target.host,
      port: Number(target.port),
      database: target.database,
      user: target.user,
      password: async () => target.password,
      max: 1,
    })
    try {
      const result = await pool.query(
        `UPDATE email SET expires_at = $1 WHERE id = $2`,
        [expiresAt, mailboxId],
      )
      assert.equal(result.rowCount, 1)
    } finally {
      await pool.end()
    }
    return
  }

  const sqlite = new Database(join(temporaryRoot, "data/http-setup.db"), {
    fileMustExist: true,
    timeout: 5_000,
  })
  try {
    const result = sqlite.prepare(`UPDATE email SET expires_at = ? WHERE id = ?`)
      .run(expiresAt.getTime(), mailboxId)
    assert.equal(result.changes, 1)
  } finally {
    sqlite.close()
  }
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
let smtpSink: Awaited<ReturnType<typeof startSmtpSink>> | null = null
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
  smtpSink = await startSmtpSink()
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

  const localizedSetupExpectations = {
    en: { marker: "Set up MoeMail", configPath: "Config file: <code" },
    "zh-CN": { marker: "一次性初始化令牌", configPath: "配置文件：<code" },
    "zh-TW": { marker: "一次性初始化權杖", configPath: "設定檔：<code" },
    ja: { marker: "MoeMail をセットアップ", configPath: "設定ファイル：<code" },
    ko: { marker: "MoeMail 설정", configPath: "구성 파일: <code" },
  } as const
  const localizedSetupHtml = new Map<string, string>()
  for (const [locale, expectation] of Object.entries(localizedSetupExpectations)) {
    const setupPage = await fetch(`${baseUrl}/${locale}/setup`)
    assert.equal(setupPage.status, 200)
    const html = await setupPage.text()
    assert.ok(html.includes(expectation.marker), `${locale} setup page must render its own translation`)
    assert.ok(
      html.includes(expectation.configPath),
      `${locale} setup page must use locale-specific punctuation and spacing`,
    )
    localizedSetupHtml.set(locale, html)
  }
  const setupHtml = localizedSetupHtml.get("zh-CN") as string
  const setupHeaderHtml = setupHtml.match(/<header[\s\S]*?<\/header>/u)?.[0]
  assert.ok(setupHeaderHtml, "setup page must render its header")
  assert.match(setupHeaderHtml, /切换语言/u)
  assert.match(setupHeaderHtml, /切换主题/u)
  assert.doesNotMatch(setupHeaderHtml, /登录\/注册/u)
  await verifyCompressedFontAsset(baseUrl, setupHtml)
  if (stagedRedactionProbe) {
    assert.doesNotMatch(setupHtml, new RegExp(stagedRcloneSecret))
    assert.match(setupHtml, /已保留现有高级配置值/)

    // 覆盖 LKG 随后丢失、runtime 仅保留已验证内存配置的边界；匿名页面仍
    // 不得把 staged secret 当作 fresh defaults 序列化出来。
    rmSync(join(temporaryRoot, "data/config.yaml"), { force: true })
    rmSync(join(temporaryRoot, "data/config.yaml.lkg"), { force: true })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_200))
    const memoryOnlySetupPage = await fetch(`${baseUrl}/zh-CN/setup`)
    assert.equal(memoryOnlySetupPage.status, 200)
    const memoryOnlyHtml = await memoryOnlySetupPage.text()
    assert.doesNotMatch(memoryOnlyHtml, new RegExp(stagedRcloneSecret))
    assert.match(memoryOnlyHtml, /已保留现有高级配置值/)
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
  const mailuBeforeSetup = await fetch(`${baseUrl}/api/config/mailu`)
  assert.equal(mailuBeforeSetup.status, 503)

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

  const authSignInFallback = await fetch(`${baseUrl}/api/auth/signin`, { redirect: "manual" })
  assert.ok([302, 303, 307, 308].includes(authSignInFallback.status))
  const authSignInEntry = new URL(authSignInFallback.headers.get("location") as string, baseUrl)
  assert.equal(authSignInEntry.pathname, "/login")
  const localizedAuthSignIn = await fetch(authSignInEntry, { redirect: "manual" })
  assert.ok([302, 303, 307, 308].includes(localizedAuthSignIn.status))
  assert.equal(
    new URL(localizedAuthSignIn.headers.get("location") as string, baseUrl).pathname,
    "/en/login",
  )
  const authErrorMarkers = {
    en: "Authentication failed",
    "zh-CN": "身份验证失败",
    "zh-TW": "身分驗證失敗",
    ja: "認証に失敗しました",
    ko: "인증에 실패했습니다",
  } as const
  for (const [locale, marker] of Object.entries(authErrorMarkers)) {
    const authErrorPage = await fetch(`${baseUrl}/${locale}/auth-error`)
    assert.equal(authErrorPage.status, 200)
    assert.ok(
      (await authErrorPage.text()).includes(marker),
      `${locale} Auth.js fallback page must render its own translation`,
    )
  }

  const jar = new CookieJar()
  const requestWithJar = async (cookieJar: CookieJar, path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    cookieJar.apply(headers)
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      redirect: init.redirect ?? "manual",
    })
    cookieJar.absorb(response.headers)
    return response
  }
  const request = (path: string, init: RequestInit = {}) => requestWithJar(jar, path, init)

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
  assert.equal(session.user?.quotas?.maxActiveMailboxes, 0)

  const localizedRuntimeTabs = {
    "zh-CN": "此面板包含明文密钥",
    ja: "このパネルには平文のシークレットが含まれます",
    ko: "이 패널에는 평문 비밀값이 포함되어 있습니다",
  } as const
  for (const [locale, marker] of Object.entries(localizedRuntimeTabs)) {
    const profile = await request(`/${locale}/profile?tab=runtime`)
    assert.equal(profile.status, 200)
    const html = await profile.text()
    assert.ok(html.includes(marker), `${locale} profile must render the selected localized runtime panel`)
    assert.match(html, /tab=runtime/u)
  }

  const unauthenticatedMailTest = await fetch(`${baseUrl}/api/config/domains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "imap", policy: {} }),
  })
  assert.equal(unauthenticatedMailTest.status, 401)
  const unauthenticatedMailuConfig = await fetch(`${baseUrl}/api/config/mailu`)
  assert.equal(unauthenticatedMailuConfig.status, 401)

  const emperorMailuConfig = await request("/api/config/mailu")
  assert.equal(emperorMailuConfig.status, 200)
  const emperorMailuBody = await emperorMailuConfig.json() as {
    configured?: boolean
    integration?: { api?: { token?: string }; collector?: { password?: string }; catchAll?: { password?: string } }
  }
  assert.equal(emperorMailuBody.configured, false)
  assert.ok((emperorMailuBody.integration?.api?.token?.length ?? 0) > 0)
  assert.ok((emperorMailuBody.integration?.collector?.password?.length ?? 0) > 0)
  assert.ok((emperorMailuBody.integration?.catchAll?.password?.length ?? 0) > 0)
  const createEmperorApiKey = await request("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "mailu-secret-boundary" }),
  })
  assert.equal(createEmperorApiKey.status, 200)
  const emperorApiKey = (await createEmperorApiKey.json() as { key?: string }).key
  assert.match(emperorApiKey ?? "", /^mk_[A-Za-z0-9_-]{32}$/u)
  const emperorApiMailuConfig = await fetch(`${baseUrl}/api/config/mailu`, {
    headers: { "X-API-Key": emperorApiKey as string },
  })
  assert.equal(emperorApiMailuConfig.status, 403)
  assert.equal(
    (await emperorApiMailuConfig.json() as { code?: string }).code,
    "API_KEY_ROUTE_FORBIDDEN",
  )

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
        outbound: {
          mode: "smtp",
          host: "127.0.0.1",
          port: smtpSink.port,
          security: "plain",
          username: null,
          password: null,
          authMethod: "auto",
          rejectUnauthorized: true,
          fromName: null,
        },
      }],
    }),
  })
  assert.equal(saveDomainPolicies.status, 200)

  const createMailbox = await request("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "setup-http@discarded.example",
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
  const sendPermissionBody = await sendPermission.json() as {
    canSend?: boolean
    canUsePrivateRecipientDelivery?: boolean
  }
  assert.equal(sendPermissionBody.canSend, true)
  assert.equal(sendPermissionBody.canUsePrivateRecipientDelivery, true)

  const accessPoliciesResponse = await request("/api/access-policies")
  assert.equal(accessPoliciesResponse.status, 200)
  const accessPoliciesBody = await accessPoliciesResponse.json() as {
    policies: {
      roles: Record<string, RoleAccessPolicy>
      mailQuotaRules: MailQuotaAssignment[]
    }
  }
  assert.equal(accessPoliciesBody.policies.mailQuotaRules.some(rule => rule.subject.type === "role" && rule.subject.role === "emperor"), false)
  accessPoliciesBody.policies.mailQuotaRules.push({ id: crypto.randomUUID(), direction: "send", subject: { type: "all" }, target: { type: "all" }, rolling: { limit: 100_000, windowValue: 1, windowUnit: "day" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }, { id: crypto.randomUUID(), direction: "send", subject: { type: "role", role: "emperor" }, target: { type: "all" }, rolling: { limit: 12, windowValue: 2, windowUnit: "hour" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }, { id: crypto.randomUUID(), direction: "send", subject: { type: "role", role: "emperor" }, target: { type: "domain", domain: validationDomain }, rolling: { limit: 4, windowValue: 30, windowUnit: "minute" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false })
  const saveRolePolicies = await request("/api/access-policies", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles: accessPoliciesBody.policies.roles, mailQuotaRules: accessPoliciesBody.policies.mailQuotaRules }),
  })
  assert.equal(saveRolePolicies.status, 200)
  const emperorUsage = await request("/api/access-policies/usage?role=emperor")
  assert.equal(emperorUsage.status, 200)
  const emperorUsageBody = await emperorUsage.json() as {
    usage?: { rules?: Array<{ assignment?: { rolling?: { limit?: number }; target?: { type?: string; domain?: string } } }> }
  }
  assert.ok(emperorUsageBody.usage?.rules?.some(rule => rule.assignment?.rolling?.limit === 12))
  assert.ok(emperorUsageBody.usage?.rules?.some(rule => rule.assignment?.target?.domain === validationDomain))
  const globalUsage = await request("/api/access-policies/usage?scope=global")
  assert.equal(globalUsage.status, 200)
  assert.equal(
    (await globalUsage.json() as { usage?: { target?: { type?: string }; rules?: Array<{ assignment?: { rolling?: { limit?: number }; subject?: { type?: string } } }> } }).usage?.rules?.find(rule => rule.assignment?.subject?.type === "all")?.assignment?.rolling?.limit,
    100_000,
  )

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
  accessPoliciesBody.policies.mailQuotaRules.push({ id: crypto.randomUUID(), direction: "send", subject: { type: "user", userId: session.user!.id! }, target: { type: "all" }, rolling: { limit: 3, windowValue: 90, windowUnit: "second" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false })
  const mutateEmperorQuota = await request("/api/access-policies", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailQuotaRules: accessPoliciesBody.policies.mailQuotaRules }) })
  assert.equal(mutateEmperorQuota.status, 200)
  const emperorUserUsage = await request(
    `/api/access-policies/usage?userId=${encodeURIComponent(session.user!.id!)}`,
  )
  assert.equal(emperorUserUsage.status, 200)
  assert.equal(
    (await emperorUserUsage.json() as { usage?: { rules?: Array<{ assignment?: { rolling?: { limit?: number }; subject?: { type?: string } } }> } }).usage?.rules?.find(rule => rule.assignment?.subject?.type === "user")?.assignment?.rolling?.limit,
    3,
  )

  const memberUsername = "domain-member"
  const memberPassword = "domain-member-password-123456"
  const registerMember = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: memberUsername, password: memberPassword }),
  })
  assert.equal(registerMember.status, 201)
  const member = await registerMember.json() as { user?: { id?: string } }
  assert.ok(member.user?.id)

  accessPoliciesBody.policies.roles.duke.quotas = {
    ...accessPoliciesBody.policies.roles.duke.quotas,
    maxActiveMailboxes: 2,
  }
  accessPoliciesBody.policies.roles.duke.domainAccess = {
    default: "deny",
    domains: { [validationDomain]: "allow" },
  }
  accessPoliciesBody.policies.mailQuotaRules = accessPoliciesBody.policies.mailQuotaRules.filter(rule => !(rule.subject.type === "role" && rule.subject.role === "duke"))
  accessPoliciesBody.policies.mailQuotaRules.push({ id: crypto.randomUUID(), direction: "send", subject: { type: "role", role: "duke" }, target: { type: "domain", domain: validationDomain }, rolling: { limit: 2, windowValue: 1, windowUnit: "hour" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }, { id: crypto.randomUUID(), direction: "receive", subject: { type: "role", role: "duke" }, target: { type: "mailbox", address: `domain-member@${validationDomain}` }, rolling: { limit: 2, windowValue: 1, windowUnit: "day" }, lifetimeLimit: 1, shareWithinRole: false, ignoreEmperor: false })
  const saveDukePolicy = await request("/api/access-policies", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles: accessPoliciesBody.policies.roles, mailQuotaRules: accessPoliciesBody.policies.mailQuotaRules }),
  })
  assert.equal(saveDukePolicy.status, 200)
  const promoteMember = await request("/api/roles/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: member.user!.id, roleName: "duke" }),
  })
  assert.equal(promoteMember.status, 200)

  const memberJar = new CookieJar()
  const memberRequest = (path: string, init: RequestInit = {}) => requestWithJar(memberJar, path, init)
  const memberCsrf = await memberRequest("/api/auth/csrf")
  assert.equal(memberCsrf.status, 200)
  const memberCsrfToken = (await memberCsrf.json() as { csrfToken?: string }).csrfToken
  assert.ok(memberCsrfToken)
  const memberLogin = await memberRequest("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: memberCsrfToken,
      username: memberUsername,
      password: memberPassword,
      callbackUrl: `${baseUrl}/zh-CN`,
    }),
  })
  assert.ok([302, 303].includes(memberLogin.status))

  const createMemberApiKey = await memberRequest("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "policy-e2e" }),
  })
  assert.equal(createMemberApiKey.status, 200)
  const memberApiKey = (await createMemberApiKey.json() as { key?: string }).key
  assert.match(memberApiKey ?? "", /^mk_[A-Za-z0-9_-]{32}$/)
  const memberApiRequest = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set("X-API-Key", memberApiKey as string)
    return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: init.redirect ?? "manual" })
  }
  const memberQuotaResponse = await memberRequest("/api/access-policies/me")
  assert.equal(memberQuotaResponse.status, 200)
  const memberQuota = await memberQuotaResponse.json() as {
    access?: { quotas?: { maxActiveMailboxes?: number }; mailQuotaRules?: unknown[] }
    usage?: { activeMailboxes?: number; activeApiKeys?: number; send?: unknown; receive?: unknown }
  }
  assert.equal(memberQuota.access?.quotas?.maxActiveMailboxes, 2)
  assert.ok(memberQuota.access?.mailQuotaRules && memberQuota.access.mailQuotaRules.length >= 2)
  assert.equal(memberQuota.usage?.activeMailboxes, 0)
  assert.equal(memberQuota.usage?.activeApiKeys, 1)
  assert.ok(memberQuota.usage?.send && memberQuota.usage.receive)
  const memberGlobalRule = (memberQuota.access?.mailQuotaRules as MailQuotaAssignment[] | undefined)
    ?.find(rule => rule.subject.type === "all")
  assert.ok(memberGlobalRule)
  const countGlobalBeforeMemberSend = await request("/api/access-policies/usage?scope=global")
  assert.equal(countGlobalBeforeMemberSend.status, 200)
  const globalBefore = (await countGlobalBeforeMemberSend.json() as { usage?: { allTimeCompleted?: number } }).usage?.allTimeCompleted ?? 0
  const memberQuotaByApiKey = await memberApiRequest("/api/access-policies/me")
  assert.equal(memberQuotaByApiKey.status, 403)
  assert.equal((await memberQuotaByApiKey.json() as { code?: string }).code, "API_KEY_ROUTE_FORBIDDEN")
  const memberMailuConfig = await memberRequest("/api/config/mailu")
  assert.equal(memberMailuConfig.status, 403)
  const memberApiMailuConfig = await memberApiRequest("/api/config/mailu")
  assert.equal(memberApiMailuConfig.status, 403)
  const crossOriginMailuMutation = await request("/api/config/mailu", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid",
      "Sec-Fetch-Site": "cross-site",
    },
    body: JSON.stringify({ kind: "reconcile" }),
  })
  assert.equal(crossOriginMailuMutation.status, 403)
  const mailboxPayload = (name: string) => JSON.stringify({
    name,
    domain: validationDomain,
    expiryTime: 3_600_000,
  })

  const globalBlockResponse = await request("/api/access-policies/mailbox-blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "global", localPart: "globally-blocked", domain: validationDomain }),
  })
  assert.equal(globalBlockResponse.status, 201)
  const globalBlock = await globalBlockResponse.json() as { block?: { id?: string } }
  assert.ok(globalBlock.block?.id)
  for (const requester of [memberRequest, memberApiRequest]) {
    const blocked = await requester("/api/emails/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: mailboxPayload("globally-blocked"),
    })
    assert.equal(blocked.status, 403)
    assert.equal((await blocked.json() as { code?: string }).code, "MAILBOX_NAME_BLOCKED")
  }
  const clearGlobalBlock = await request(
    `/api/access-policies/mailbox-blocks?id=${encodeURIComponent(globalBlock.block!.id!)}`,
    { method: "DELETE" },
  )
  assert.equal(clearGlobalBlock.status, 200)

  const userBlockResponse = await request("/api/access-policies/mailbox-blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "user",
      userId: member.user!.id,
      localPart: "user-blocked",
      domain: validationDomain,
    }),
  })
  assert.equal(userBlockResponse.status, 201)
  const userBlock = await userBlockResponse.json() as { block?: { id?: string } }
  assert.ok(userBlock.block?.id)
  const userBlockedViaApi = await memberApiRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("user-blocked"),
  })
  assert.equal(userBlockedViaApi.status, 403)
  assert.equal((await userBlockedViaApi.json() as { code?: string }).code, "MAILBOX_NAME_BLOCKED")
  const sameAddressForEmperor = await request("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("user-blocked"),
  })
  assert.equal(sameAddressForEmperor.status, 200)
  const emperorScopedMailbox = await sameAddressForEmperor.json() as { id: string }
  assert.equal((await request(`/api/emails/${emperorScopedMailbox.id}`, { method: "DELETE" })).status, 200)
  const clearUserBlock = await request(
    `/api/access-policies/mailbox-blocks?id=${encodeURIComponent(userBlock.block!.id!)}`,
    { method: "DELETE" },
  )
  assert.equal(clearUserBlock.status, 200)

  const invalidRoleBlock = await request("/api/access-policies/mailbox-blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "roles",
      allowedRoles: ["emperor"],
      localPart: "invalid-role-reservation",
      domain: validationDomain,
    }),
  })
  assert.equal(invalidRoleBlock.status, 400)
  assert.equal((await invalidRoleBlock.json() as { code?: string }).code, "INVALID_REQUEST")

  const roleBlockResponse = await request("/api/access-policies/mailbox-blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "roles",
      allowedRoles: ["knight"],
      localPart: "reserved-for-knights",
      domain: validationDomain,
    }),
  })
  assert.equal(roleBlockResponse.status, 201)
  const roleBlock = await roleBlockResponse.json() as { block?: { id?: string } }
  assert.ok(roleBlock.block?.id)
  const roleDeniedMember = await memberRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("reserved-for-knights"),
  })
  assert.equal(roleDeniedMember.status, 403)
  assert.equal((await roleDeniedMember.json() as { code?: string }).code, "MAILBOX_NAME_BLOCKED")
  const promoteMemberToKnight = await request("/api/roles/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: member.user!.id, roleName: "knight" }),
  })
  assert.equal(promoteMemberToKnight.status, 200)
  const roleAllowedMember = await memberRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("reserved-for-knights"),
  })
  assert.equal(roleAllowedMember.status, 200)
  const roleAllowedMemberMailbox = await roleAllowedMember.json() as { id: string }
  assert.equal((await memberRequest(`/api/emails/${roleAllowedMemberMailbox.id}`, { method: "DELETE" })).status, 200)
  const restoreMemberToDuke = await request("/api/roles/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: member.user!.id, roleName: "duke" }),
  })
  assert.equal(restoreMemberToDuke.status, 200)
  const roleAllowedEmperor = await request("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("reserved-for-knights"),
  })
  assert.equal(roleAllowedEmperor.status, 200)
  const roleAllowedMailbox = await roleAllowedEmperor.json() as { id: string }
  assert.equal((await request(`/api/emails/${roleAllowedMailbox.id}`, { method: "DELETE" })).status, 200)
  assert.equal((await request(
    `/api/access-policies/mailbox-blocks?id=${encodeURIComponent(roleBlock.block!.id!)}`,
    { method: "DELETE" },
  )).status, 200)

  const memberMailboxResponse = await memberRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("domain-member"),
  })
  assert.equal(memberMailboxResponse.status, 200)
  const memberMailbox = await memberMailboxResponse.json() as { id: string; email: string }

  const sendMultipleRecipients = await memberRequest(`/api/emails/${memberMailbox.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: "first-recipient@example.net; SECOND-recipient@example.net, first-recipient@example.net",
      subject: "multiple recipient quota integration",
      content: "multi-recipient marker",
      format: "text",
    }),
  })
  assert.equal(sendMultipleRecipients.status, 200)
  assert.equal((await sendMultipleRecipients.json() as { remainingEmails?: number }).remainingEmails, 0)
  const countGlobalAfterMemberSend = await request("/api/access-policies/usage?scope=global")
  assert.equal(countGlobalAfterMemberSend.status, 200)
  assert.equal(
    (await countGlobalAfterMemberSend.json() as { usage?: { allTimeCompleted?: number } }).usage?.allTimeCompleted,
    globalBefore + 2,
  )
  assert.equal(smtpSink.messages.length, 1)
  assert.match(smtpSink.messages[0], /first-recipient@example\.net/iu)
  assert.match(smtpSink.messages[0], /second-recipient@example\.net/iu)

  const resetVisibleDeliveryCharge = await request("/api/access-policies/usage", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: "send" satisfies MailDirection, role: "duke" }),
  })
  assert.equal(resetVisibleDeliveryCharge.status, 200)
  assert.equal((await resetVisibleDeliveryCharge.json() as { deleted?: number }).deleted, 2)

  accessPoliciesBody.policies.roles.duke.permissions.private_recipient_delivery = false
  const denyPrivateDeliveryPermission = await request("/api/access-policies", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles: accessPoliciesBody.policies.roles }),
  })
  assert.equal(denyPrivateDeliveryPermission.status, 200)
  const privateDeliveryCapabilityDenied = await memberRequest(
    `/api/emails/send-permission?emailId=${encodeURIComponent(memberMailbox.id)}`,
  )
  assert.equal(privateDeliveryCapabilityDenied.status, 200)
  assert.equal(
    (await privateDeliveryCapabilityDenied.json() as { canUsePrivateRecipientDelivery?: boolean })
      .canUsePrivateRecipientDelivery,
    false,
  )
  const privateDeliveryDenied = await memberRequest(`/api/emails/${memberMailbox.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: "private-one@example.net, private-two@example.net",
      subject: "private permission denied",
      content: "must not reach SMTP",
      format: "text",
      privateRecipients: true,
    }),
  })
  assert.equal(privateDeliveryDenied.status, 403)
  assert.equal(
    (await privateDeliveryDenied.json() as { code?: string }).code,
    "PRIVATE_RECIPIENT_DELIVERY_FORBIDDEN",
  )
  assert.equal(smtpSink.messages.length, 1)

  accessPoliciesBody.policies.roles.duke.permissions.private_recipient_delivery = true
  const allowPrivateDeliveryPermission = await request("/api/access-policies", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roles: accessPoliciesBody.policies.roles }),
  })
  assert.equal(allowPrivateDeliveryPermission.status, 200)
  const privateDeliveryCapabilityAllowed = await memberRequest(
    `/api/emails/send-permission?emailId=${encodeURIComponent(memberMailbox.id)}`,
  )
  assert.equal(privateDeliveryCapabilityAllowed.status, 200)
  assert.equal(
    (await privateDeliveryCapabilityAllowed.json() as { canUsePrivateRecipientDelivery?: boolean })
      .canUsePrivateRecipientDelivery,
    true,
  )
  const privateDelivery = await memberRequest(`/api/emails/${memberMailbox.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: "private-one@example.net, private-two@example.net",
      subject: "private recipient delivery",
      content: "private delivery marker",
      format: "text",
      privateRecipients: true,
    }),
  })
  assert.equal(privateDelivery.status, 200)
  assert.equal((await privateDelivery.json() as { remainingEmails?: number }).remainingEmails, 0)
  assert.equal(smtpSink.messages.length, 3)
  assert.match(smtpSink.messages[1], /To: private-one@example\.net/iu)
  assert.doesNotMatch(smtpSink.messages[1], /private-two@example\.net/iu)
  assert.match(smtpSink.messages[2], /To: private-two@example\.net/iu)
  assert.doesNotMatch(smtpSink.messages[2], /private-one@example\.net/iu)
  const sendAfterAtomicCharge = await memberRequest(`/api/emails/${memberMailbox.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: "third-recipient@example.net",
      subject: "quota overflow",
      content: "must not reach SMTP",
      format: "text",
    }),
  })
  assert.equal(sendAfterAtomicCharge.status, 429)
  assert.equal((await sendAfterAtomicCharge.json() as { code?: string }).code, "SEND_DOMAIN_QUOTA_EXCEEDED")
  assert.equal(smtpSink.messages.length, 3)
  const resetMultiRecipientCharge = await request("/api/access-policies/usage", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: "send" satisfies MailDirection, role: "duke" }),
  })
  assert.equal(resetMultiRecipientCharge.status, 200)
  assert.equal((await resetMultiRecipientCharge.json() as { deleted?: number }).deleted, 2)

  const denyMemberDomain = await request(
    `/api/access-policies/users/${encodeURIComponent(member.user!.id!)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissions: {},
        quotas: {},
        domainAccess: { default: "deny", domains: {} },
      }),
    },
  )
  assert.equal(denyMemberDomain.status, 200)

  const deniedCreate = await memberRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "domain-member-denied",
      domain: validationDomain,
      expiryTime: 3_600_000,
    }),
  })
  assert.equal(deniedCreate.status, 403)
  assert.equal((await deniedCreate.json() as { code?: string }).code, "MAIL_DOMAIN_FORBIDDEN")

  const deniedMemberMessage = Buffer.from([
    "From: sender@example.net",
    `To: ${memberMailbox.email}`,
    "Subject: domain permission must reject",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "domain permission marker",
  ].join("\r\n"))
  const deniedIngest = await fetch(`${baseUrl}/api/internal/email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${completedBody.emailIngestSecret}`,
      "Content-Type": "message/rfc822",
      "X-MoeMail-Envelope-From": "sender@example.net",
      "X-MoeMail-Envelope-To": memberMailbox.email,
      "X-MoeMail-Raw-Size": String(deniedMemberMessage.byteLength),
    },
    body: deniedMemberMessage,
  })
  assert.equal(deniedIngest.status, 403)
  assert.deepEqual(await deniedIngest.json(), {
    status: "rejected",
    reason: "MAIL_DOMAIN_RECEIVE_FORBIDDEN",
    error: "MAIL_DOMAIN_RECEIVE_FORBIDDEN",
    code: "MAIL_DOMAIN_RECEIVE_FORBIDDEN",
  })

  const deniedSendPermission = await memberRequest(
    `/api/emails/send-permission?emailId=${encodeURIComponent(memberMailbox.id)}`,
  )
  assert.equal(deniedSendPermission.status, 200)
  assert.equal((await deniedSendPermission.json() as { code?: string }).code, "MAIL_DOMAIN_SEND_FORBIDDEN")

  const setMemberDomainMode = (mode: DomainAccessMode, extra: Record<string, unknown> = {}) => request(
    `/api/access-policies/users/${encodeURIComponent(member.user!.id!)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissions: {},
        quotas: {},
        domainAccess: { default: "deny", domains: { [validationDomain]: mode } },
        ...extra,
      }),
    },
  )

  const receiveOnlyDomain = await setMemberDomainMode("receive")
  assert.equal(receiveOnlyDomain.status, 200)
  const receiveOnlySend = await memberApiRequest(
    `/api/emails/send-permission?emailId=${encodeURIComponent(memberMailbox.id)}`,
  )
  assert.equal(receiveOnlySend.status, 200)
  assert.equal((await receiveOnlySend.json() as { code?: string }).code, "MAIL_DOMAIN_SEND_FORBIDDEN")

  const ingestFor = async (target: { email: string }, marker: string) => {
    const raw = Buffer.from([
      "From: sender@example.net",
      `To: ${target.email}`,
      `Subject: ${marker}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      marker,
    ].join("\r\n"))
    return fetch(`${baseUrl}/api/internal/email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${completedBody.emailIngestSecret}`,
        "Content-Type": "message/rfc822",
        "X-MoeMail-Envelope-From": "sender@example.net",
        "X-MoeMail-Envelope-To": target.email,
        "X-MoeMail-Raw-Size": String(raw.byteLength),
      },
      body: raw,
    })
  }

  const firstLifetimeReceive = await ingestFor(memberMailbox, "mailbox lifetime first")
  assert.equal(firstLifetimeReceive.status, 201)
  const lifetimeExceeded = await ingestFor(memberMailbox, "mailbox lifetime second")
  assert.equal(lifetimeExceeded.status, 429)
  assert.deepEqual(await lifetimeExceeded.json(), {
    status: "rejected",
    reason: "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED",
    error: "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED",
    code: "RECEIVE_MAILBOX_LIFETIME_QUOTA_EXCEEDED",
  })

  const receiveOnlyMailboxResponse = await memberApiRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("receive-only"),
  })
  assert.equal(receiveOnlyMailboxResponse.status, 200)
  const receiveOnlyMailbox = await receiveOnlyMailboxResponse.json() as { id: string; email: string }
  assert.equal((await ingestFor(receiveOnlyMailbox, "receive-only domain mode")).status, 201)
  assert.equal((await memberRequest(`/api/emails/${receiveOnlyMailbox.id}`, { method: "DELETE" })).status, 200)

  // Exactly one of these requests may consume the one remaining active-mailbox
  // slot. Half use the browser session and half use the API key so neither
  // authentication path can bypass the same atomic quota.
  const concurrentCreates = await Promise.all(Array.from({ length: 8 }, (_, index) => (
    (index % 2 === 0 ? memberRequest : memberApiRequest)("/api/emails/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: mailboxPayload(`parallel-${index}`),
    })
  )))
  assert.equal(concurrentCreates.filter(response => response.status === 200).length, 1)
  assert.equal(concurrentCreates.filter(response => response.status === 403).length, 7)
  const parallelMailboxResponse = concurrentCreates.find(response => response.status === 200)
  assert.ok(parallelMailboxResponse)
  const parallelMailbox = await parallelMailboxResponse.json() as { id: string; email: string }
  assert.ok(parallelMailbox.id && parallelMailbox.email.includes("@"))
  for (const response of concurrentCreates.filter(response => response.status === 403)) {
    assert.equal((await response.json() as { code?: string }).code, "MAILBOX_QUOTA_EXCEEDED")
  }
  const quotaByApiKey = await memberApiRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("api-key-overflow"),
  })
  assert.equal(quotaByApiKey.status, 403)
  assert.equal((await quotaByApiKey.json() as { code?: string }).code, "MAILBOX_QUOTA_EXCEEDED")

  const sendOnlyDomain = await setMemberDomainMode("send")
  assert.equal(sendOnlyDomain.status, 200)
  const sendOnlyPermission = await memberApiRequest(
    `/api/emails/send-permission?emailId=${encodeURIComponent(memberMailbox.id)}`,
  )
  assert.equal(sendOnlyPermission.status, 200)
  assert.equal((await sendOnlyPermission.json() as { canSend?: boolean }).canSend, true)
  const sendOnlyInbound = await ingestFor(memberMailbox, "send-only domain mode")
  assert.equal(sendOnlyInbound.status, 403)
  assert.deepEqual(await sendOnlyInbound.json(), {
    status: "rejected",
    reason: "MAIL_DOMAIN_RECEIVE_FORBIDDEN",
    error: "MAIL_DOMAIN_RECEIVE_FORBIDDEN",
    code: "MAIL_DOMAIN_RECEIVE_FORBIDDEN",
  })

  const allowMemberDomain = await setMemberDomainMode("allow")
  assert.equal(allowMemberDomain.status, 200)
  assert.equal((await memberRequest(`/api/emails/${memberMailbox.id}`, { method: "DELETE" })).status, 200)
  const recreatedResponse = await memberRequest("/api/emails/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: mailboxPayload("domain-member"),
  })
  assert.equal(recreatedResponse.status, 200)
  const recreatedMailbox = await recreatedResponse.json() as { id: string; email: string }
  assert.equal(recreatedMailbox.email, memberMailbox.email)
  const lifetimeSurvivesRecreation = await ingestFor(recreatedMailbox, "lifetime survives recreation")
  assert.equal(lifetimeSurvivesRecreation.status, 429)

  const quotaBeforeReset = await memberApiRequest(`/api/emails/${recreatedMailbox.id}/quota`)
  assert.equal(quotaBeforeReset.status, 200)
  assert.equal(
    (await quotaBeforeReset.json() as { receive?: { quota?: { applied?: Array<{ lifetimeRemaining?: number }> } } })
      .receive?.quota?.applied?.find(item => item.lifetimeRemaining !== null)?.lifetimeRemaining,
    0,
  )
  const resetExactMailbox = await request("/api/access-policies/usage", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      direction: "receive" satisfies MailDirection,
      userId: member.user!.id,
      mailboxAddress: recreatedMailbox.email,
    }),
  })
  assert.equal(resetExactMailbox.status, 200)
  assert.ok((await resetExactMailbox.json() as { deleted?: number }).deleted)
  const receiveAfterReset = await ingestFor(recreatedMailbox, "receive after emperor reset")
  assert.equal(receiveAfterReset.status, 201)
  const createdMessageId = (await receiveAfterReset.json() as { messageId?: string }).messageId
  assert.ok(createdMessageId)

  const customShareStart = Date.now()
  const customMailboxShare = await memberApiRequest(`/api/emails/${recreatedMailbox.id}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 5_400_000 }),
  })
  assert.equal(customMailboxShare.status, 201)
  const customMailboxShareBody = await customMailboxShare.json() as { expiresAt?: string | null }
  const customMailboxShareToken = (customMailboxShareBody as { token?: string }).token
  assert.ok(customMailboxShareToken)
  const customMailboxExpiry = Date.parse(customMailboxShareBody.expiresAt ?? "")
  assert.ok(customMailboxExpiry >= customShareStart + 5_390_000)
  assert.ok(customMailboxExpiry <= Date.now() + 5_410_000)
  const permanentMailboxShare = await memberRequest(`/api/emails/${recreatedMailbox.id}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 0 }),
  })
  assert.equal(permanentMailboxShare.status, 201)
  assert.equal((await permanentMailboxShare.json() as { expiresAt?: string | null }).expiresAt, null)
  const invalidMailboxShare = await memberRequest(`/api/emails/${recreatedMailbox.id}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 30_000 }),
  })
  assert.equal(invalidMailboxShare.status, 400)
  assert.equal((await invalidMailboxShare.json() as { code?: string }).code, "INVALID_SHARE_EXPIRY")
  const customMessageShare = await memberApiRequest(
    `/api/emails/${recreatedMailbox.id}/messages/${createdMessageId}/share`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 7_200_000 }),
    },
  )
  assert.equal(customMessageShare.status, 201)
  const customMessageShareBody = await customMessageShare.json() as {
    expiresAt?: string
    token?: string
  }
  assert.ok(Date.parse(customMessageShareBody.expiresAt ?? "") > Date.now())
  assert.ok(customMessageShareBody.token)

  accessPoliciesBody.policies.mailQuotaRules = accessPoliciesBody.policies.mailQuotaRules.filter(rule => !(rule.subject.type === "user" && rule.subject.userId === member.user!.id && rule.direction === "send"))
  accessPoliciesBody.policies.mailQuotaRules.push({ id: crypto.randomUUID(), direction: "send", subject: { type: "user", userId: member.user!.id! }, target: { type: "all" }, rolling: { limit: 0, windowValue: 45, windowUnit: "second" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false })
  const disableMemberSendQuota = await request("/api/access-policies", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailQuotaRules: accessPoliciesBody.policies.mailQuotaRules }) })
  assert.equal(disableMemberSendQuota.status, 200)
  const disabledByUserQuota = await memberRequest(
    `/api/emails/send-permission?emailId=${encodeURIComponent(recreatedMailbox.id)}`,
  )
  assert.equal(disabledByUserQuota.status, 200)
  assert.equal(
    (await disabledByUserQuota.json() as { error?: string }).error,
    "SEND_TOTAL_QUOTA_EXCEEDED",
  )

  await expireMailbox(recreatedMailbox.id)
  const expiredMailboxPaths: Array<[string, (path: string, init?: RequestInit) => Promise<Response>, RequestInit?]> = [
    [`/api/emails/${recreatedMailbox.id}`, memberRequest],
    [`/api/emails/${recreatedMailbox.id}/${createdMessageId}`, memberApiRequest],
    [`/api/emails/${recreatedMailbox.id}/${createdMessageId}`, memberRequest, { method: "DELETE" }],
    [`/api/emails/${recreatedMailbox.id}/quota`, memberRequest],
    [`/api/emails/send-permission?emailId=${encodeURIComponent(recreatedMailbox.id)}`, memberApiRequest],
    [`/api/emails/${recreatedMailbox.id}/share`, memberRequest],
    [`/api/emails/${recreatedMailbox.id}/share`, memberApiRequest, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 60_000 }),
    }],
    [`/api/emails/${recreatedMailbox.id}/messages/${createdMessageId}/share`, memberRequest],
  ]
  for (const [path, requester, init] of expiredMailboxPaths) {
    const response = await requester(path, init)
    assert.equal(response.status, 410, `${path} must reject an expired mailbox`)
    assert.equal((await response.json() as { code?: string }).code, "MAILBOX_EXPIRED")
  }
  const expiredMailboxShare = await fetch(`${baseUrl}/api/shared/${customMailboxShareToken}`)
  assert.equal(expiredMailboxShare.status, 410)
  assert.equal((await expiredMailboxShare.json() as { code?: string }).code, "MAILBOX_EXPIRED")
  const expiredMessageShare = await fetch(`${baseUrl}/api/shared/message/${customMessageShareBody.token}`)
  assert.equal(expiredMessageShare.status, 410)
  assert.equal((await expiredMessageShare.json() as { code?: string }).code, "MAILBOX_EXPIRED")
  const deleteExpiredMailbox = await memberRequest(
    `/api/emails/${recreatedMailbox.id}`,
    { method: "DELETE" },
  )
  assert.equal(deleteExpiredMailbox.status, 200)

  // A non-Emperor may be granted user-management permission, but the
  // database transaction must still reject deleting the Emperor. This proves
  // the invariant is enforced server-side rather than by a hidden UI button.
  const grantMemberUserManagement = await setMemberDomainMode("allow", {
    permissions: { promote_user: true },
  })
  assert.equal(grantMemberUserManagement.status, 200)
  const protectedEmperorDelete = await memberRequest(
    `/api/users/${encodeURIComponent(session.user!.id!)}`,
    { method: "DELETE" },
  )
  assert.equal(protectedEmperorDelete.status, 400)
  assert.equal(
    (await protectedEmperorDelete.json() as { code?: string }).code,
    "CANNOT_DELETE_EMPEROR",
  )

  // Exercise the complete ordinary-user deletion unit: a non-cascading API
  // key, a site_config policy override, and a user-scoped mailbox block must
  // disappear with the user, while the deleted key becomes unusable.
  const deletionUsername = "delete-tx-target"
  const deletionPassword = "delete-transaction-password-123456"
  const deletionRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: deletionUsername, password: deletionPassword }),
  })
  assert.equal(
    deletionRegistration.status,
    201,
    `deletion fixture registration failed: ${await deletionRegistration.clone().text()}`,
  )
  const deletionUserId = (await deletionRegistration.json() as { user?: { id?: string } }).user?.id
  assert.ok(deletionUserId)
  const promoteDeletionTarget = await request("/api/roles/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: deletionUserId, roleName: "duke" }),
  })
  assert.equal(promoteDeletionTarget.status, 200)

  const deletionJar = new CookieJar()
  const deletionRequest = (path: string, init: RequestInit = {}) => requestWithJar(deletionJar, path, init)
  const deletionCsrf = await deletionRequest("/api/auth/csrf")
  assert.equal(deletionCsrf.status, 200)
  const deletionCsrfToken = (await deletionCsrf.json() as { csrfToken?: string }).csrfToken
  assert.ok(deletionCsrfToken)
  const deletionLogin = await deletionRequest("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: deletionCsrfToken,
      username: deletionUsername,
      password: deletionPassword,
      callbackUrl: `${baseUrl}/zh-CN`,
    }),
  })
  assert.ok([302, 303].includes(deletionLogin.status))
  const deletionKeyResponse = await deletionRequest("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "delete-transaction-key" }),
  })
  assert.equal(deletionKeyResponse.status, 200)
  const deletionApiKey = (await deletionKeyResponse.json() as { key?: string }).key
  assert.match(deletionApiKey ?? "", /^mk_[A-Za-z0-9_-]{32}$/)
  const deletionOverride = await request(
    `/api/access-policies/users/${encodeURIComponent(deletionUserId!)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissions: { send_email: false },
        quotas: { maxActiveMailboxes: 1 },
      }),
    },
  )
  assert.equal(deletionOverride.status, 200)
  const deletionBlockResponse = await request("/api/access-policies/mailbox-blocks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "user",
      userId: deletionUserId,
      localPart: "deleted-user-only",
      domain: validationDomain,
    }),
  })
  assert.equal(deletionBlockResponse.status, 201)
  const deletionBlockId = (await deletionBlockResponse.json() as { block?: { id?: string } }).block?.id
  assert.ok(deletionBlockId)

  const deleteOrdinaryUser = await request(`/api/users/${encodeURIComponent(deletionUserId!)}`, {
    method: "DELETE",
  })
  assert.equal(deleteOrdinaryUser.status, 200)
  const deletedKeyProbe = await fetch(`${baseUrl}/api/emails`, {
    headers: { "X-API-Key": deletionApiKey! },
  })
  assert.equal(deletedKeyProbe.status, 401)
  assert.equal((await deletedKeyProbe.json() as { code?: string }).code, "API_KEY_INVALID")
  const deletedUserSearch = await request(
    `/api/roles/users?page=1&pageSize=50&search=${encodeURIComponent(deletionUsername)}`,
  )
  assert.equal(deletedUserSearch.status, 200)
  assert.equal((await deletedUserSearch.json() as { total?: number }).total, 0)
  const policiesAfterUserDelete = await request("/api/access-policies")
  assert.equal(policiesAfterUserDelete.status, 200)
  assert.equal(
    (await policiesAfterUserDelete.json() as { policies?: { users?: Record<string, unknown> } })
      .policies?.users?.[deletionUserId!],
    undefined,
  )
  const recreateDeletedOverride = await request(
    `/api/access-policies/users/${encodeURIComponent(deletionUserId!)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        permissions: { send_email: false },
        quotas: { maxActiveMailboxes: 1 },
      }),
    },
  )
  assert.equal(recreateDeletedOverride.status, 404)
  assert.equal(
    (await recreateDeletedOverride.json() as { code?: string }).code,
    "USER_NOT_FOUND",
  )
  const resetDeletedOverride = await request(
    `/api/access-policies/users/${encodeURIComponent(deletionUserId!)}`,
    { method: "DELETE" },
  )
  assert.equal(resetDeletedOverride.status, 404)
  assert.equal(
    (await resetDeletedOverride.json() as { code?: string }).code,
    "USER_NOT_FOUND",
  )
  const promoteDeletedUser = await request("/api/roles/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: deletionUserId, roleName: "duke" }),
  })
  assert.equal(promoteDeletedUser.status, 404)
  assert.equal(
    (await promoteDeletedUser.json() as { code?: string }).code,
    "USER_NOT_FOUND",
  )
  const policiesAfterDeletedOverrideAttempts = await request("/api/access-policies")
  assert.equal(policiesAfterDeletedOverrideAttempts.status, 200)
  assert.equal(
    (await policiesAfterDeletedOverrideAttempts.json() as {
      policies?: { users?: Record<string, unknown> }
    }).policies?.users?.[deletionUserId!],
    undefined,
  )
  const blocksAfterUserDelete = await request("/api/access-policies/mailbox-blocks")
  assert.equal(blocksAfterUserDelete.status, 200)
  assert.equal(
    (await blocksAfterUserDelete.json() as { blocks?: Array<{ id?: string }> }).blocks
      ?.some(block => block.id === deletionBlockId),
    false,
  )

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

  const appearanceMarker = "moemail-advanced-appearance-http-marker"
  const advancedAppearance = await request("/api/config/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      advancedEnabled: true,
      customCss: `:root { --${appearanceMarker}: 1; }`,
      headHtml: `<meta name="${appearanceMarker}" content="head">`,
      bodyEndHtml: `<div data-${appearanceMarker}="body"></div>`,
      customJs: `globalThis["${appearanceMarker}"] = true`,
      customJsEnabled: true,
    }),
  })
  assert.equal(advancedAppearance.status, 200)
  const advancedAppearanceBody = await advancedAppearance.json() as {
    advancedEnabled?: boolean
    customJsEnabled?: boolean
  }
  assert.equal(advancedAppearanceBody.advancedEnabled, true)
  assert.equal(advancedAppearanceBody.customJsEnabled, true)

  const appearanceRead = await request("/api/config/appearance")
  assert.equal(appearanceRead.status, 200)
  assert.match(await appearanceRead.text(), new RegExp(appearanceMarker))

  const appearancePage = await request("/zh-CN/profile")
  assert.equal(appearancePage.status, 200)
  assert.match(await appearancePage.text(), new RegExp(appearanceMarker))

  const safeAppearancePage = await request("/zh-CN/profile?safe-appearance=1")
  assert.equal(safeAppearancePage.status, 200)
  assert.doesNotMatch(await safeAppearancePage.text(), new RegExp(appearanceMarker))

  const oversizedAppearance = await request("/api/config/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customCss: "x".repeat(128 * 1024 + 1) }),
  })
  assert.equal(oversizedAppearance.status, 400)

  const clearAdvancedAppearance = await request("/api/config/appearance", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      advancedEnabled: false,
      customCss: "",
      headHtml: "",
      bodyEndHtml: "",
      customJs: "",
      customJsEnabled: false,
    }),
  })
  assert.equal(clearAdvancedAppearance.status, 200)

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
    authFallbackPagesLocalized: true,
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
    mailuConfigSessionPermissionAndOriginGate: true,
    domainPolicyAndWorkerIngestion: true,
    accessDomainAndSendQuotaApis: true,
    roleToUserFourStateDomainEnforcementE2e: true,
    userSendQuotaEnforcementE2e: true,
    multiRecipientAtomicQuotaAndSmtpE2e: true,
    privateRecipientPermissionAndDeliveryE2e: true,
    sessionAndApiKeyPolicyParityE2e: true,
    atomicMailboxQuotaE2e: true,
    globalUserAndRoleMailboxBlocksE2e: true,
    selfQuotaSummaryAndApiKeyBoundaryE2e: true,
    receiveLifetimeQuotaSurvivesRecreationE2e: true,
    emperorExactMailboxResetE2e: true,
    customAndPermanentShareExpiryE2e: true,
    independentOutboundDisable: true,
    emperorAccessImmutable: true,
    emperorDeletionProtectedServerSide: true,
    atomicUserDeletionAndCredentialRevocationE2e: true,
    appearanceValidation: true,
    advancedAppearanceInjectionAndSafeMode: true,
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
  await smtpSink?.close().catch(() => undefined)
  if (server) await stop(server)
  rmSync(temporaryRoot, { recursive: true, force: true })
}
