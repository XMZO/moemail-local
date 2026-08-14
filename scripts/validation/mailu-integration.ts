import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net"
import { cpSync, mkdtempSync, rmSync, unwatchFile } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { eq } from "drizzle-orm"
import PostalMime from "postal-mime"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-mailu-integration-"))
const integrationId = "7f1237d4-c6cf-4bea-8a93-12804a2e3d95"
const apiToken = "mailu-api-validation-token"
const collector = "moemail-collector@mailu-service.test"
const catchAll = "moemail-catchall@mailu-service.test"
const collectorPassword = "collector-password-validation"
const catchAllPassword = "catchall-password-validation"
const managedDomain = "mailu-validation.test"
const inboundOnlyDomain = "mailu-inbound-only.test"
const mailboxAddress = `inbox@${managedDomain}`
const inboundOnlyAddress = `receive-only@${inboundOnlyDomain}`
const deniedSenderAddress = `denied-sender@${managedDomain}`
const expiringSenderAddress = `expired-sender@${managedDomain}`
const unknownAddress = `missing@${managedDomain}`

type MailuUser = {
  email: string
  comment: string
  enabled: boolean
  enable_imap: boolean
  enable_pop: boolean
  allow_spoofing: boolean
  forward_enabled: boolean
  forward_destination: string[]
  forward_keep: boolean
  raw_password?: string
}
type MailuAlias = {
  email: string
  destination: string[]
  comment: string
  wildcard: boolean
  disabled: boolean
}

function readJson(request: import("node:http").IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", chunk => {
      const buffer = Buffer.from(chunk)
      size += buffer.byteLength
      if (size > 64 * 1024) {
        request.destroy()
        reject(new Error("request too large"))
        return
      }
      chunks.push(buffer)
    })
    request.on("end", () => {
      try { resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) }
      catch (error) { reject(error) }
    })
    request.on("error", reject)
  })
}

function createMockMailuApi() {
  const users = new Map<string, MailuUser>()
  const aliases = new Map<string, MailuAlias>()
  const operations: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
  const domains = [{ name: "mailu-service.test" }, { name: managedDomain }, { name: inboundOnlyDomain }]
  const server = createHttpServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${apiToken}`)
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const method = request.method ?? "GET"
      const body = method === "GET" ? {} : await readJson(request)
      operations.push({ method, path: url.pathname, body })
      response.setHeader("Content-Type", "application/json")
      const send = (status: number, value: unknown) => {
        response.statusCode = status
        response.end(JSON.stringify(value))
      }
      if (url.pathname === "/api/v1/domain" && method === "GET") return send(200, domains)
      if (url.pathname === "/api/v1/user" && method === "GET") return send(200, [...users.values()])
      if (url.pathname === "/api/v1/alias" && method === "GET") return send(200, [...aliases.values()])
      if (url.pathname === "/api/v1/user" && method === "POST") {
        const email = String(body.email).toLowerCase()
        if (users.has(email)) return send(409, { code: 409 })
        users.set(email, {
          email,
          comment: String(body.comment ?? ""),
          enabled: Boolean(body.enabled),
          enable_imap: Boolean(body.enable_imap),
          enable_pop: Boolean(body.enable_pop),
          allow_spoofing: Boolean(body.allow_spoofing),
          forward_enabled: Boolean(body.forward_enabled),
          forward_destination: Array.isArray(body.forward_destination) ? body.forward_destination.map(String) : [],
          forward_keep: Boolean(body.forward_keep),
          raw_password: String(body.raw_password),
        })
        return send(200, { code: 200 })
      }
      if (url.pathname.startsWith("/api/v1/user/")) {
        const email = decodeURIComponent(url.pathname.slice("/api/v1/user/".length)).toLowerCase()
        const user = users.get(email)
        if (!user) return send(404, { code: 404 })
        if (method === "GET") return send(200, user)
        if (method === "PATCH") {
          Object.assign(user, body)
          return send(200, { code: 200 })
        }
      }
      if (url.pathname === "/api/v1/alias" && method === "POST") {
        const email = String(body.email).toLowerCase()
        if (aliases.has(email)) return send(409, { code: 409 })
        aliases.set(email, {
          email,
          destination: (body.destination as unknown[]).map(value => String(value).toLowerCase()),
          comment: String(body.comment ?? ""),
          wildcard: Boolean(body.wildcard),
          disabled: false,
        })
        return send(200, { code: 200 })
      }
      if (url.pathname.startsWith("/api/v1/alias/")) {
        const email = decodeURIComponent(url.pathname.slice("/api/v1/alias/".length)).toLowerCase()
        const alias = aliases.get(email)
        if (!alias) return send(404, { code: 404 })
        if (method === "GET") return send(200, alias)
        if (method === "PATCH") {
          Object.assign(alias, body)
          return send(200, { code: 200 })
        }
        if (method === "DELETE") {
          aliases.delete(email)
          return send(200, { code: 200 })
        }
      }
      return send(404, { code: 404 })
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown" }))
    }
  })
  return new Promise<{ server: typeof server; port: number; users: typeof users; aliases: typeof aliases; operations: typeof operations }>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      assert(address && typeof address === "object")
      resolvePromise({ server, port: address.port, users, aliases, operations })
    })
  })
}

type MockImapMessage = { uid: number; raw: Buffer; deleted: boolean }

function quote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function createMockImap(messages: MockImapMessage[], options: { safeRetention?: boolean } = {}) {
  const safeRetention = options.safeRetention ?? true
  const capabilityLine = `IMAP4rev1 ID ENABLE NAMESPACE${safeRetention ? " UIDPLUS MOVE" : ""}`
  const commands: string[] = []
  const sockets = new Set<Socket>()
  const server = createNetServer(socket => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.setNoDelay(true)
    socket.write(`* OK [CAPABILITY ${capabilityLine}] Mailu validation ready\r\n`)
    let input = ""
    socket.on("data", chunk => {
      input += chunk.toString("utf8")
      while (true) {
        const end = input.indexOf("\r\n")
        if (end < 0) break
        const line = input.slice(0, end)
        input = input.slice(end + 2)
        if (!line) continue
        commands.push(line)
        const [tag = "", commandName = ""] = line.split(" ", 2)
        const command = commandName.toUpperCase()
        const ok = (message: string) => socket.write(`${tag} OK ${message}\r\n`)
        if (command === "CAPABILITY") {
          socket.write(`* CAPABILITY ${capabilityLine}\r\n`); ok("CAPABILITY completed")
        } else if (command === "ID") {
          socket.write("* ID (\"name\" \"Mailu mock\")\r\n"); ok("ID completed")
        } else if (command === "LOGIN") {
          assert.match(line, /moemail-collector@mailu-service\.test/iu)
          assert.match(line, /collector-password-validation/iu)
          ok("LOGIN completed")
        } else if (command === "NAMESPACE") {
          socket.write("* NAMESPACE ((\"\" \"/\")) NIL NIL\r\n"); ok("NAMESPACE completed")
        } else if (command === "ENABLE") {
          socket.write("* ENABLED\r\n"); ok("ENABLE completed")
        } else if (command === "LIST") {
          socket.write(`* LIST (\\HasNoChildren) "/" ${quote("INBOX")}\r\n`); ok("LIST completed")
        } else if (command === "SELECT" || command === "EXAMINE") {
          const active = messages.filter(message => !message.deleted)
          socket.write(`* ${active.length} EXISTS\r\n`)
          socket.write("* FLAGS (\\Seen \\Deleted)\r\n")
          socket.write("* OK [UIDVALIDITY 99001] UIDs valid\r\n")
          socket.write(`* OK [UIDNEXT ${Math.max(0, ...messages.map(message => message.uid)) + 1}] next UID\r\n`)
          ok(command === "SELECT" ? "[READ-WRITE] selected" : "[READ-ONLY] selected")
        } else if (command === "UID") {
          const upper = line.toUpperCase()
          if (upper.includes(" SEARCH ")) {
            const range = line.match(/UID (\d+):(\d+)/iu)
            const lower = Number(range?.[1] ?? 1)
            const upperUid = Number(range?.[2] ?? Number.MAX_SAFE_INTEGER)
            const found = messages.filter(message => !message.deleted && message.uid >= lower && message.uid <= upperUid).map(message => message.uid)
            socket.write(`* SEARCH${found.length ? ` ${found.join(" ")}` : ""}\r\n`); ok("SEARCH completed")
          } else if (upper.includes(" FETCH ")) {
            const uid = Number(line.match(/UID FETCH (\d+)/iu)?.[1])
            const message = messages.find(item => item.uid === uid && !item.deleted)
            if (!message) { ok("FETCH completed"); continue }
            if (upper.includes("RFC822.SIZE")) socket.write(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${message.raw.byteLength})\r\n`)
            else if (upper.includes("BODY.PEEK[]") || upper.includes("BODY[]")) {
              socket.write(`* ${uid} FETCH (UID ${uid} BODY[] {${message.raw.byteLength}}\r\n`)
              socket.write(message.raw); socket.write(")\r\n")
            } else socket.write(`* ${uid} FETCH (UID ${uid} FLAGS ())\r\n`)
            ok("FETCH completed")
          } else if (upper.includes(" STORE ") && upper.includes("\\DELETED")) {
            const uid = Number(line.match(/UID STORE (\d+)/iu)?.[1])
            const message = messages.find(item => item.uid === uid)
            if (message) message.deleted = true
            ok("STORE completed")
          } else if (upper.includes(" EXPUNGE ")) {
            const uid = Number(line.match(/UID EXPUNGE (\d+)/iu)?.[1])
            const message = messages.find(item => item.uid === uid)
            if (message) message.deleted = true
            ok("UID EXPUNGE completed")
          } else if (upper.includes(" MOVE ")) {
            const uid = Number(line.match(/UID MOVE (\d+)/iu)?.[1])
            const message = messages.find(item => item.uid === uid)
            if (message) message.deleted = true
            ok("UID MOVE completed")
          } else socket.write(`${tag} BAD unsupported UID command\r\n`)
        } else if (command === "EXPUNGE") {
          ok("EXPUNGE completed")
        } else if (command === "LOGOUT") {
          socket.write("* BYE logging out\r\n"); ok("LOGOUT completed")
        } else socket.write(`${tag} BAD unsupported ${command}\r\n`)
      }
    })
  })
  return new Promise<{ server: NetServer; port: number; commands: string[]; close: () => Promise<void> }>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      assert(address && typeof address === "object")
      resolvePromise({
        server,
        port: address.port,
        commands,
        close: async () => {
          for (const socket of sockets) socket.destroy()
          await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        },
      })
    })
  })
}

function createMockSmtp() {
  const envelopes: Array<{ from: string; recipients: string[]; data: string }> = []
  const server = createNetServer(socket => {
    socket.setEncoding("utf8")
    socket.write("220 mailu-validation ESMTP\r\n")
    let input = ""
    let data = ""
    let from = ""
    let recipients: string[] = []
    let dataMode = false
    socket.on("data", chunk => {
      input += chunk
      while (true) {
        const end = input.indexOf("\r\n")
        if (end < 0) break
        const line = input.slice(0, end)
        input = input.slice(end + 2)
        if (dataMode) {
          if (line === ".") {
            dataMode = false
            envelopes.push({ from, recipients: [...recipients], data })
            data = ""
            socket.write("250 queued\r\n")
          } else data += `${line}\r\n`
        } else if (/^EHLO /iu.test(line)) socket.write("250-mailu-validation\r\n250 AUTH PLAIN LOGIN\r\n")
        else if (/^AUTH PLAIN /iu.test(line)) {
          const payload = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8")
          assert.equal(payload, `\0${collector}\0${collectorPassword}`)
          socket.write("235 authenticated\r\n")
        } else if (/^MAIL FROM:/iu.test(line)) {
          from = line.match(/<([^>]*)>/u)?.[1] ?? ""
          recipients = []
          socket.write("250 ok\r\n")
        } else if (/^RCPT TO:/iu.test(line)) {
          recipients.push(line.match(/<([^>]*)>/u)?.[1] ?? "")
          socket.write("250 ok\r\n")
        } else if (/^DATA$/iu.test(line)) {
          dataMode = true
          socket.write("354 end\r\n")
        } else if (/^QUIT$/iu.test(line)) socket.end("221 bye\r\n")
        else socket.write("250 ok\r\n")
      }
    })
  })
  return new Promise<{ server: NetServer; port: number; envelopes: typeof envelopes }>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      assert(address && typeof address === "object")
      resolvePromise({ server, port: address.port, envelopes })
    })
  })
}

const message = (to: string, subject: string) => Buffer.from([
  "Return-Path: <sender@outside.test>",
  `Delivered-To: <${to}>`,
  `To: forged@${managedDomain}`,
  "From: sender@outside.test",
  `Subject: ${subject}`,
  "Content-Type: text/html; charset=utf-8",
  "",
  '<script>globalThis.pwned=true</script><img src=x onerror="globalThis.pwned=true"><p>safe marker</p>',
].join("\r\n"))

const imapMessages: MockImapMessage[] = [
  { uid: 1, raw: message(unknownAddress, "Unknown catch-all"), deleted: false },
  { uid: 2, raw: message(mailboxAddress, "Mailu durable message"), deleted: false },
  { uid: 3, raw: message(mailboxAddress, "Mailu durable message"), deleted: false },
]

let mailuApi: Awaited<ReturnType<typeof createMockMailuApi>> | null = null
let imap: Awaited<ReturnType<typeof createMockImap>> | null = null
let smtp: Awaited<ReturnType<typeof createMockSmtp>> | null = null

try {
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(temporaryRoot, "drizzle-local"), { recursive: true })
  cpSync(resolve(repositoryRoot, "drizzle-postgres"), join(temporaryRoot, "drizzle-postgres"), { recursive: true })
  process.chdir(temporaryRoot)
  mailuApi = await createMockMailuApi()
  imap = await createMockImap(imapMessages)
  smtp = await createMockSmtp()

  const setup = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/setup-service.ts")).href)
  const setupOutcome = await setup.completeSetup({
    config: {
      server: { baseUrl: "http://127.0.0.1:3000" },
      database: { driver: "sqlite", sqlite: { path: "data/mailu-validation.db" } },
    },
    admin: { username: "mailu-owner", password: "mailu-validation-password-123456" },
  })
  assert.equal(setupOutcome.ok, true)

  const database = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/db.ts")).href)
  const schema = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/schema.ts")).href)
  const configModule = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/mailu/config.ts")).href)
  const domains = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/domain-policies.ts")).href)
  const reconciliation = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/mailu/reconcile.ts")).href)
  const inbound = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/mailu/inbound.ts")).href)
  const outbound = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/mailu/outbound.ts")).href)

  const integration = configModule.mailuIntegrationSchema.parse({
    version: 1,
    integrationId,
    enabled: true,
    api: { baseUrl: `http://127.0.0.1:${mailuApi.port}/api/v1`, token: apiToken, timeoutSeconds: 2 },
    collector: { address: collector, password: collectorPassword },
    catchAll: { address: catchAll, password: catchAllPassword },
    imap: {
      host: "127.0.0.1",
      port: imap.port,
      security: "plain",
      rejectUnauthorized: true,
      mailbox: "INBOX",
      recipientHeader: "delivered-to",
      initialSync: "unseen",
      pollIntervalSeconds: 15,
      maxMessagesPerPoll: 10,
    },
    smtp: {
      host: "127.0.0.1",
      port: smtp.port,
      security: "plain",
      authMethod: "plain",
      rejectUnauthorized: true,
      fromName: "MoeMail Mailu",
    },
    reconciliation: { enabled: true, intervalSeconds: 30, createCatchAll: true, removeStaleAliases: true },
    retention: { action: "delete", delaySeconds: 0 },
  })
  assert.equal(configModule.defaultMailuIntegration().imap.recipientHeader, "delivered-to")
  assert.equal(configModule.mailuIntegrationSchema.safeParse({ ...integration, api: { ...integration.api, token: "replace-me" } }).success, false)
  assert.equal(configModule.mailuIntegrationSchema.safeParse({ ...integration, api: { ...integration.api, token: "abc" } }).success, false)
  await configModule.saveMailuIntegration(integration)
  await domains.saveDomainPolicies([
    { domain: managedDomain, inbound: { mode: "mailu" }, outbound: { mode: "mailu" } },
    { domain: inboundOnlyDomain, inbound: { mode: "mailu" }, outbound: { mode: "disabled" } },
  ])

  const db = database.createDb()
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.username, "mailu-owner")).limit(1)
  assert(owner)
  await db.insert(schema.emails).values({ address: mailboxAddress, userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) })
  await db.insert(schema.emails).values({ address: inboundOnlyAddress, userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) })
  const [dukeRole] = await db.insert(schema.roles).values({ name: "duke", description: null }).returning()
  const [expiringSender] = await db.insert(schema.users).values({ username: "mailu-expiring-sender" }).returning()
  await db.insert(schema.userRoles).values({ userId: expiringSender.id, roleId: dukeRole.id })
  const [expiringMailbox] = await db.insert(schema.emails).values({ address: expiringSenderAddress, userId: expiringSender.id, expiresAt: new Date(Date.now() + 3_600_000) }).returning()

  const reconciled = await reconciliation.reconcileMailu(integration)
  assert.equal(reconciled.created, 5)
  const collectorUser = mailuApi.users.get(collector)
  const catchAllUser = mailuApi.users.get(catchAll)
  assert(collectorUser && catchAllUser)
  assert.deepEqual({ imap: collectorUser.enable_imap, pop: collectorUser.enable_pop, spoof: collectorUser.allow_spoofing, forward: collectorUser.forward_enabled }, { imap: true, pop: false, spoof: false, forward: false })
  assert.deepEqual({ enabled: catchAllUser.enabled, imap: catchAllUser.enable_imap, pop: catchAllUser.enable_pop, spoof: catchAllUser.allow_spoofing, forward: catchAllUser.forward_enabled, destination: catchAllUser.forward_destination, keep: catchAllUser.forward_keep }, { enabled: false, imap: false, pop: false, spoof: false, forward: true, destination: [collector], keep: false })
  assert.deepEqual(mailuApi.aliases.get(mailboxAddress)?.destination, [collector])
  assert.equal(mailuApi.aliases.get(mailboxAddress)?.wildcard, false)
  assert.deepEqual(mailuApi.aliases.get(`%@${managedDomain}`)?.destination, [catchAll])
  assert.equal(mailuApi.aliases.get(`%@${managedDomain}`)?.wildcard, true)
  assert.deepEqual(mailuApi.aliases.get(inboundOnlyAddress)?.destination, [catchAll])
  assert.deepEqual(mailuApi.aliases.get(`%@${inboundOnlyDomain}`)?.destination, [catchAll])
  assert.deepEqual(mailuApi.aliases.get(expiringSenderAddress)?.destination, [collector])

  await db.update(schema.emails).set({ expiresAt: new Date(0) }).where(eq(schema.emails.id, expiringMailbox.id))
  const [deniedSender] = await db.insert(schema.users).values({ username: "mailu-denied-sender" }).returning()
  await db.insert(schema.emails).values({ address: deniedSenderAddress, userId: deniedSender.id, expiresAt: new Date(Date.now() + 3_600_000) })
  const disabledOwnedAlias = mailuApi.aliases.get(mailboxAddress)
  assert(disabledOwnedAlias)
  disabledOwnedAlias.disabled = true
  collectorUser.allow_spoofing = true
  const noStaleCleanupIntegration = {
    ...integration,
    reconciliation: { ...integration.reconciliation, removeStaleAliases: false },
  }
  await configModule.saveMailuIntegration(noStaleCleanupIntegration)
  const repaired = await reconciliation.reconcileMailu(noStaleCleanupIntegration)
  assert.equal(repaired.created, 1)
  assert.equal(repaired.updated, 1)
  assert.equal(repaired.removed, 1)
  assert.equal(mailuApi.aliases.get(mailboxAddress)?.disabled, false)
  assert.equal(mailuApi.users.get(collector)?.allow_spoofing, false)
  assert.equal(mailuApi.aliases.has(expiringSenderAddress), false, "expired collector authorization must be removed even when stale catch-all cleanup is disabled")
  assert.deepEqual(
    mailuApi.aliases.get(deniedSenderAddress)?.destination,
    [catchAll],
    "an active mailbox without MoeMail send permission must not authorize the collector in Mailu sender-login",
  )
  await assert.rejects(
    reconciliation.ensureMailuSenderAlias(noStaleCleanupIntegration, deniedSenderAddress),
    /MAILU_SENDER_PERMISSION_DENIED/u,
  )
  await configModule.saveMailuIntegration(integration)
  assert(mailuApi.operations.some(operation => operation.method === "DELETE" && operation.path.endsWith(`/${mailboxAddress}`)))
  await new (await import(pathToFileURL(resolve(repositoryRoot, "app/lib/mailu/client.ts")).href)).MailuClient(integration).getAlias(mailboxAddress)
  assert(mailuApi.operations.some(operation => operation.path.includes(`/${mailboxAddress}`)), "Mailu route must preserve @ in path parameters")

  const foreignAlias: MailuAlias = { email: `foreign@${managedDomain}`, destination: [collector], comment: "human-owned", wildcard: false, disabled: false }
  mailuApi.aliases.set(foreignAlias.email, foreignAlias)
  const foreignMailbox = await db.insert(schema.emails).values({ address: foreignAlias.email, userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) }).returning()
  await assert.rejects(reconciliation.reconcileMailu(integration), /MAILU_ALIAS_OWNERSHIP_CONFLICT/u)
  const rotatedCollectorPassword = "rotated-collector-password-validation"
  await reconciliation.rotateMailuServiceCredentials({
    ...integration,
    collector: { ...integration.collector, password: rotatedCollectorPassword },
  }, "collector")
  assert.equal(mailuApi.users.get(collector)?.raw_password, rotatedCollectorPassword)
  assert.equal(mailuApi.users.get(catchAll)?.raw_password, catchAllPassword)
  await db.delete(schema.emails).where(eq(schema.emails.id, foreignMailbox[0].id))
  mailuApi.aliases.delete(foreignAlias.email)

  const parsedForged = await PostalMime.parse(message(mailboxAddress, "Header validation"))
  assert.equal(inbound.mailuEnvelopeRecipient(parsedForged, integration), mailboxAddress)
  const duplicatedTrace = await PostalMime.parse(Buffer.from(message(mailboxAddress, "Ambiguous").toString("utf8").replace(`Delivered-To: <${mailboxAddress}>`, `Delivered-To: <${mailboxAddress}>\r\nDelivered-To: <forged@${managedDomain}>`)))
  assert.equal(inbound.mailuEnvelopeRecipient(duplicatedTrace, integration), null)

  const firstPoll = await inbound.pollMailuIntegration(integration)
  assert.equal(firstPoll.processed, 2)
  assert.equal(imapMessages[0].deleted, false, "unknown recipient must remain in Mailu")
  assert.equal(imapMessages[1].deleted, true, "durably committed message should be deleted after the configured delay")
  assert.equal(imapMessages[2].deleted, true, "a proven duplicate should also complete retention idempotently")
  const stored = await db.select().from(schema.messages)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].toAddress, mailboxAddress)
  assert.equal(stored[0].subject, "Mailu durable message")
  assert.match(stored[0].html ?? "", /globalThis\.pwned/u, "raw HTML is stored; the shared sandboxed viewer performs rendering isolation")
  const secondPoll = await inbound.pollMailuIntegration(integration)
  assert.equal(secondPoll.processed, 0)
  assert(imap.commands.some(command => /\bSTORE\b/iu.test(command)))
  assert(imap.commands.some(command => /\bUID EXPUNGE\b/iu.test(command)))

  await imap.close()
  const unsafeMessage: MockImapMessage = {
    uid: 1,
    raw: message(mailboxAddress, "Unsafe expunge must stop"),
    deleted: false,
  }
  imap = await createMockImap([unsafeMessage], { safeRetention: false })
  const unsafeRetentionIntegration = configModule.mailuIntegrationSchema.parse({
    ...integration,
    imap: { ...integration.imap, port: imap.port },
  })
  await configModule.saveMailuIntegration(unsafeRetentionIntegration)
  await assert.rejects(
    inbound.pollMailuIntegration(unsafeRetentionIntegration),
    /MAILU_IMAP_SAFE_DELETE_UNAVAILABLE/u,
  )
  assert.equal(unsafeMessage.deleted, false)
  assert.equal(imap.commands.some(command => /^\S+ EXPUNGE\b/iu.test(command)), false)
  await configModule.saveMailuIntegration(integration)

  await outbound.sendWithMailu(integration, mailboxAddress, {
    to: ["first@outside.test", "second@outside.test"],
    subject: "Private Mailu delivery",
    content: "private marker",
    format: "text",
    privateRecipients: true,
  })
  assert.equal(smtp.envelopes.length, 2)
  for (const envelope of smtp.envelopes) {
    assert.equal(envelope.from, mailboxAddress)
    assert.equal(envelope.recipients.length, 1)
  }
  const firstDelivery = smtp.envelopes.find(envelope => envelope.recipients[0] === "first@outside.test")
  const secondDelivery = smtp.envelopes.find(envelope => envelope.recipients[0] === "second@outside.test")
  assert(firstDelivery && secondDelivery)
  assert.doesNotMatch(firstDelivery.data, /second@outside\.test/iu)
  assert.doesNotMatch(secondDelivery.data, /first@outside\.test/iu)

  await assert.rejects(outbound.sendWithMailu(integration, `forged@${managedDomain}`, {
    to: ["target@outside.test"], subject: "Spoof", content: "no", format: "text", privateRecipients: false,
  }), /MAILU_SENDER_MAILBOX_INACTIVE/u)
  await assert.rejects(outbound.sendWithMailu(integration, "forged@outside.test", {
    to: ["target@outside.test"], subject: "Spoof", content: "no", format: "text", privateRecipients: false,
  }), /MAILU_SENDER_DOMAIN_DISABLED/u)
  assert.equal(smtp.envelopes.length, 2)

  const viewerSource = await import("node:fs").then(fs => fs.readFileSync(resolve(repositoryRoot, "app/components/emails/html-message-frame.tsx"), "utf8"))
  assert.match(viewerSource, /script-src 'none'/u)
  assert.match(viewerSource, /sandbox="allow-popups allow-popups-to-escape-sandbox"/u)
  assert.match(viewerSource, /name\.startsWith\("on"\)/u)

  await database.closeDatabase()
  console.log(JSON.stringify({
    mailuApiContractFromLocalSource: true,
    exactAliasBeforeCatchAll: true,
    inboundOnlyAliasesCannotAuthorizeCollector: true,
    disabledOwnedAliasRecreated: true,
    serviceUserSecurityDriftRepaired: true,
    credentialRotationIndependentOfAliasConflicts: true,
    collectorCannotWildcardSpoof: true,
    catchAllAccountCannotAuthenticate: true,
    envelopeRecipientUsesDeliveredToOnly: true,
    ambiguousTraceFailsClosed: true,
    unknownCatchAllDoesNotStarveQueue: true,
    retentionOnlyAfterDurableCommit: true,
    unsafePlainExpungeRejected: true,
    imapCursorDeduplicates: true,
    privateSmtpRecipientsIsolated: true,
    deniedMailboxCannotAuthorizeCollector: true,
    expiredMailboxCollectorAuthorizationRevoked: true,
    localAndExternalFromSpoofingRejected: true,
    existingHtmlSandboxReused: true,
  }))
} finally {
  if (smtp) await new Promise<void>(resolveClose => smtp!.server.close(() => resolveClose())).catch(() => undefined)
  if (imap) await imap.close().catch(() => undefined)
  if (mailuApi) await new Promise<void>(resolveClose => mailuApi!.server.close(() => resolveClose())).catch(() => undefined)
  unwatchFile(join(temporaryRoot, "data", "config.yaml"))
  process.chdir(repositoryRoot)
  try {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error
    const cleanup = spawn(process.execPath, ["-e", "setTimeout(()=>require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:20,retryDelay:100}),1000)", temporaryRoot], { detached: true, stdio: "ignore", windowsHide: true })
    cleanup.unref()
  }
}
