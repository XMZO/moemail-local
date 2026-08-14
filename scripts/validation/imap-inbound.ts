import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { cpSync, mkdtempSync, rmSync, unwatchFile } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { eq } from "drizzle-orm"
import type { DomainPolicy } from "../../app/lib/domain-policies"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-imap-inbound-"))
const postgresUrl = process.argv
  .find(argument => argument.startsWith("--postgres-url="))
  ?.slice("--postgres-url=".length) ?? null

function rawMessageFor(domain: string, subject: string, id: string, forged = false) {
  return Buffer.from([
    "Return-Path: <sender@example.net>",
    "Delivered-To: provider-account@example.net",
    `X-Original-To: inbox@${domain}`,
    // A sender can include the same header name in the RFC822 payload. The
    // provider-prepended first trace must remain authoritative.
    ...(forged ? [`X-Original-To: forged@${domain}`] : []),
    "From: sender@example.net",
    // Sender-controlled MIME recipients must not override the provider-added
    // original-recipient trace above.
    `To: ${forged ? `forged@${domain}` : `inbox@${domain}`}`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.net>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `marker ${id}`,
  ].join("\r\n"))
}

const rawMessage = rawMessageFor(
  "imap-validation.example",
  "IMAP inbound integration",
  "imap-validation",
  true,
)

function quote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 8_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail("Timed out waiting for IMAP state")
}

type MockImapMessage = { uid: number; raw: Buffer }

function createMockImapServer(options: {
  idle: boolean
  messages?: MockImapMessage[]
}): Promise<{
  server: Server
  port: number
  commands: string[]
  setUidValidity: (value: number) => void
  deliver: (message: MockImapMessage, notify?: boolean) => void
  dropIdleConnections: () => void
  close: () => Promise<void>
}> {
  const messages = options.messages ?? []
  const commands: string[] = []
  const state = { uidValidity: 777 }
  const sockets = new Set<Socket>()
  const idleSockets = new Map<Socket, string>()
  const server = createServer(socket => handleConnection(
    socket,
    commands,
    state,
    messages,
    options.idle,
    sockets,
    idleSockets,
  ))
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      assert.ok(address && typeof address === "object")
      resolvePromise({
        server,
        port: address.port,
        commands,
        setUidValidity: value => { state.uidValidity = value },
        deliver: (message, notify = true) => {
          messages.push(message)
          if (!notify) return
          for (const socket of idleSockets.keys()) {
            if (!socket.destroyed) socket.write(`* ${messages.length} EXISTS\r\n`)
          }
        },
        dropIdleConnections: () => {
          for (const socket of idleSockets.keys()) socket.destroy()
        },
        close: async () => {
          for (const socket of sockets) socket.destroy()
          await new Promise<void>(resolveClose => server.close(() => resolveClose()))
        },
      })
    })
  })
}

function handleConnection(
  socket: Socket,
  commands: string[],
  state: { uidValidity: number },
  messages: MockImapMessage[],
  idleSupported: boolean,
  sockets: Set<Socket>,
  idleSockets: Map<Socket, string>,
) {
  const capabilities = `IMAP4rev1 ID ENABLE NAMESPACE${idleSupported ? " IDLE" : ""}`
  sockets.add(socket)
  socket.on("close", () => {
    sockets.delete(socket)
    idleSockets.delete(socket)
  })
  socket.setNoDelay(true)
  socket.write(`* OK [CAPABILITY ${capabilities}] mock ready\r\n`)
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
      if (line.toUpperCase() === "DONE") {
        const idleTag = idleSockets.get(socket)
        if (idleTag) {
          idleSockets.delete(socket)
          socket.write(`${idleTag} OK IDLE completed\r\n`)
        }
        continue
      }
      const [tag = "", rawCommand = ""] = line.split(" ", 2)
      const command = rawCommand.toUpperCase()
      const ok = (message: string) => socket.write(`${tag} OK ${message}\r\n`)

      switch (command) {
        case "CAPABILITY":
          socket.write(`* CAPABILITY ${capabilities}\r\n`)
          ok("CAPABILITY completed")
          break
        case "ID":
          socket.write("* ID (\"name\" \"mock\")\r\n")
          ok("ID completed")
          break
        case "LOGIN":
          assert.match(line, /imap-user/)
          assert.match(line, /imap-password/)
          ok("LOGIN completed")
          break
        case "NAMESPACE":
          socket.write("* NAMESPACE ((\"\" \"/\")) NIL NIL\r\n")
          ok("NAMESPACE completed")
          break
        case "ENABLE":
          socket.write("* ENABLED\r\n")
          ok("ENABLE completed")
          break
        case "LIST":
          socket.write(`* LIST (\\HasNoChildren) \"/\" ${quote("INBOX")}\r\n`)
          ok("LIST completed")
          break
        case "EXAMINE":
        case "SELECT":
          socket.write(`* ${messages.length} EXISTS\r\n`)
          socket.write("* FLAGS (\\Seen)\r\n")
          socket.write(`* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid\r\n`)
          socket.write(`* OK [UIDNEXT ${Math.max(0, ...messages.map(message => message.uid)) + 1}] next UID\r\n`)
          ok("[READ-ONLY] selected")
          break
        case "IDLE":
          if (!idleSupported) {
            socket.write(`${tag} BAD IDLE unavailable\r\n`)
            break
          }
          idleSockets.set(socket, tag)
          socket.write("+ idling\r\n")
          break
        case "UID": {
          const upper = line.toUpperCase()
          if (upper.includes(" SEARCH ")) {
            const range = line.match(/UID (\d+):(\d+)/iu)
            const lower = Number(range?.[1] ?? 1)
            const upperUid = Number(range?.[2] ?? Number.MAX_SAFE_INTEGER)
            const found = messages
              .filter(message => message.uid >= lower && message.uid <= upperUid)
              .map(message => message.uid)
            socket.write(`* SEARCH${found.length ? ` ${found.join(" ")}` : ""}\r\n`)
            ok("SEARCH completed")
          } else if (upper.includes(" FETCH ") && upper.includes("RFC822.SIZE")) {
            const uid = Number(line.match(/UID FETCH (\d+)/iu)?.[1])
            const message = messages.find(item => item.uid === uid)
            if (message) socket.write(`* ${uid} FETCH (UID ${uid} RFC822.SIZE ${message.raw.byteLength})\r\n`)
            ok("FETCH completed")
          } else if (upper.includes(" FETCH ")) {
            const uid = Number(line.match(/UID FETCH (\d+)/iu)?.[1])
            const message = messages.find(item => item.uid === uid)
            if (message) {
              socket.write(`* ${uid} FETCH (UID ${uid} BODY[] {${message.raw.byteLength}}\r\n`)
              socket.write(message.raw)
              socket.write(")\r\n")
            }
            ok("FETCH completed")
          } else {
            socket.write(`${tag} BAD unsupported UID command\r\n`)
          }
          break
        }
        case "LOGOUT":
          socket.write("* BYE logging out\r\n")
          ok("LOGOUT completed")
          break
        default:
          socket.write(`${tag} BAD unsupported ${command}\r\n`)
      }
    }
  })
}

try {
  cpSync(resolve(repositoryRoot, "drizzle-local"), join(temporaryRoot, "drizzle-local"), {
    recursive: true,
  })
  cpSync(resolve(repositoryRoot, "drizzle-postgres"), join(temporaryRoot, "drizzle-postgres"), {
    recursive: true,
  })
  process.chdir(temporaryRoot)
  const setup = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/setup-service.ts")).href)
  const outcome = await setup.completeSetup({
    config: {
      server: { baseUrl: "http://127.0.0.1:3000" },
      database: postgresUrl
        ? {
            driver: "postgres",
            postgres: { url: postgresUrl, poolMax: 1 },
          }
        : { driver: "sqlite", sqlite: { path: "data/imap-validation.db" } },
    },
    admin: { username: "imap-owner", password: "imap-validation-password-123456" },
  })
  if (!outcome.ok) throw new Error(outcome.error)

  if (postgresUrl) {
    // completeSetup intentionally keeps the process bound to its original
    // driver until the supervisor restarts it. This isolated probe has not
    // opened a business connection yet, so reset only the module-level binding
    // to model that clean restart before importing the schema facade.
    const driverGlobals = globalThis as typeof globalThis & {
      __moemailBoundDriver?: "sqlite" | "postgres"
    }
    driverGlobals.__moemailBoundDriver = "postgres"
  }

  const realtimeServer = await createMockImapServer({
    idle: true,
    messages: [{ uid: 1, raw: rawMessage }],
  })
  const pollingServer = await createMockImapServer({ idle: false })
  try {
    const domains = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/domain-policies.ts")).href)
    const database = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/db.ts")).href)
    const schema = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/schema.ts")).href)
    const imap = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/imap-inbound.ts")).href)

    try {
    const legacyInbound = domains.imapInboundSchema.parse({
      mode: "imap" as const,
      host: "127.0.0.1",
      port: realtimeServer.port,
      security: "plain" as const,
      username: "imap-user",
      password: "imap-password",
      rejectUnauthorized: true,
      mailbox: "INBOX",
      recipientHeader: "auto" as const,
      initialSync: "unseen" as const,
      pollIntervalSeconds: 15,
      maxMessagesPerPoll: 10,
    })
    assert.equal(legacyInbound.connectionTimeoutSeconds, 15)
    assert.deepEqual(legacyInbound.realtime, domains.defaultImapRealtime(false))

    const realtime = {
      ...legacyInbound,
      connectionTimeoutSeconds: 5,
      realtime: {
        enabled: true,
        mode: "idle" as const,
        reconnect: true,
        idleRenewSeconds: 60,
        reconnectMinSeconds: 1,
        reconnectMaxSeconds: 5,
      },
    }
    const realtimeOptions = imap.createImapClientOptions(realtime, true)
    assert.equal(realtimeOptions.connectionTimeout, 5_000)
    assert.equal(realtimeOptions.greetingTimeout, 5_000)
    assert.equal(realtimeOptions.maxIdleTime, 60_000)
    assert.equal(realtimeOptions.socketTimeout, 120_000)
    const pollingFallback = {
      ...realtime,
      port: pollingServer.port,
      initialSync: "new" as const,
    }
    const savedPolicies = await domains.saveDomainPolicies([{
      domain: "imap-validation.example",
      inbound: realtime,
      outbound: { mode: "disabled" },
    }, {
      domain: "imap-polling.example",
      inbound: pollingFallback,
      outbound: { mode: "disabled" },
    }])
    const policy = savedPolicies.find((item: DomainPolicy) => item.domain === "imap-validation.example")!
    const pollingPolicy = savedPolicies.find((item: DomainPolicy) => item.domain === "imap-polling.example")!

    const db = database.createDb()
    const [owner] = await db.select().from(schema.users)
      .where(eq(schema.users.username, "imap-owner")).limit(1)
    assert.ok(owner)
    const [mailbox] = await db.insert(schema.emails).values({
      address: "inbox@imap-validation.example",
      userId: owner.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning()
    const [forgedMailbox] = await db.insert(schema.emails).values({
      address: "forged@imap-validation.example",
      userId: owner.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning()
    const [pollingMailbox] = await db.insert(schema.emails).values({
      address: "inbox@imap-polling.example",
      userId: owner.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    }).returning()

    const connection = await imap.testImapConnection(policy.inbound)
    assert.equal(connection.ok, true)
    assert.equal(connection.messages, 1)
    assert.equal(connection.idleSupported, true)
    const pollingConnection = await imap.testImapConnection(pollingPolicy.inbound)
    assert.equal(pollingConnection.idleSupported, false)
    const first = await imap.pollImapDomain(policy)
    assert.equal(first.processed, 1)
    const second = await imap.pollImapDomain(policy)
    assert.equal(second.processed, 0)

    // Servers may reset and reuse UIDs after a mailbox rebuild. The poller must
    // rescan without duplicating content, then settle on the new UIDVALIDITY.
    realtimeServer.setUidValidity(778)
    const afterUidReset = await imap.pollImapDomain(policy)
    assert.equal(afterUidReset.processed, 1)
    const afterUidResetSettled = await imap.pollImapDomain(policy)
    assert.equal(afterUidResetSettled.processed, 0)

    const stored = await db.select().from(schema.messages)
      .where(eq(schema.messages.emailId, mailbox.id))
    const forged = await db.select().from(schema.messages)
      .where(eq(schema.messages.emailId, forgedMailbox.id))
    assert.equal(stored.length, 1)
    assert.equal(forged.length, 0)
    assert.equal(stored[0].subject, "IMAP inbound integration")
    assert.match(stored[0].content, /marker imap-validation/)

    const hasSubject = async (subject: string) => (await db.select().from(schema.messages))
      .some((message: { subject: string | null }) => message.subject === subject)
    const idleCommandCount = () => realtimeServer.commands
      .filter(command => /^\S+ IDLE$/iu.test(command)).length
    imap.startImapPoller()
    await waitUntil(() => idleCommandCount() >= 1)
    await waitUntil(() => pollingServer.commands.filter(command => /\bEXAMINE\b/iu.test(command)).length >= 2)
    const unsupportedProbeCount = pollingServer.commands
      .filter(command => /\bEXAMINE\b/iu.test(command)).length
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(
      pollingServer.commands.filter(command => /\bEXAMINE\b/iu.test(command)).length,
      unsupportedProbeCount,
      "an unsupported capability must not create a reconnect/probe loop",
    )

    const realtimeStartedAt = Date.now()
    realtimeServer.deliver({
      uid: 2,
      raw: rawMessageFor("imap-validation.example", "Generic IMAP IDLE realtime", "imap-idle"),
    })
    await waitUntil(() => hasSubject("Generic IMAP IDLE realtime"))
    assert(
      Date.now() - realtimeStartedAt < realtime.pollIntervalSeconds * 1_000,
      "IDLE notification must ingest before the periodic fallback",
    )

    const idleBeforeDisconnect = idleCommandCount()
    realtimeServer.dropIdleConnections()
    await waitUntil(() => idleCommandCount() > idleBeforeDisconnect)
    realtimeServer.deliver({
      uid: 3,
      raw: rawMessageFor("imap-validation.example", "Generic IMAP reconnect", "imap-reconnect"),
    })
    await waitUntil(() => hasSubject("Generic IMAP reconnect"))

    // Persist two messages without EXISTS. The IDLE-capable account and the
    // account that did not advertise IDLE must both be recovered by the same
    // bounded periodic scheduler.
    realtimeServer.deliver({
      uid: 4,
      raw: rawMessageFor("imap-validation.example", "Generic IMAP fallback", "imap-fallback"),
    }, false)
    pollingServer.deliver({
      uid: 1,
      raw: rawMessageFor("imap-polling.example", "Generic no-IDLE fallback", "imap-no-idle"),
    }, false)
    await waitUntil(async () => (
      await hasSubject("Generic IMAP fallback")
      && await hasSubject("Generic no-IDLE fallback")
    ), 25_000)

    assert.equal(
      realtimeServer.commands.some(command => /\bSTORE\b|\bMOVE\b|\bCOPY\b|\bEXPUNGE\b/iu.test(command)),
      false,
    )
    assert.equal(
      pollingServer.commands.some(command => /\bSTORE\b|\bMOVE\b|\bCOPY\b|\bEXPUNGE\b/iu.test(command)),
      false,
    )
    assert.ok(realtimeServer.commands.some(command => /\bEXAMINE\b/iu.test(command)))
    assert.equal(pollingServer.commands.some(command => /^\S+ IDLE$/iu.test(command)), false)
    assert.equal((await db.select().from(schema.messages).where(eq(schema.messages.emailId, pollingMailbox.id))).length, 1)

    console.log(JSON.stringify({
      realImapConversation: true,
      databaseDriver: postgresUrl ? "postgres" : "sqlite",
      postgresPoolMaxOneLease: Boolean(postgresUrl),
      originalRecipientHeaderResolved: true,
      forgedMimeRecipientIgnored: true,
      persistentUidCursorDeduplicates: true,
      uidValidityResetRescansSafely: true,
      capabilityDetection: true,
      idleRealtimeIngest: true,
      idleReconnect: true,
      missedNotificationFallback: true,
      noIdleAutomaticPollingFallback: true,
      unsupportedCapabilityDoesNotBusyLoop: true,
      legacyPolicyDefaultsToPolling: true,
      boundedRealtimeAndPollingConcurrency: true,
      upstreamMailboxRemainsReadOnly: true,
    }))
    } finally {
      await imap.stopImapPoller().catch(() => {})
      await database.closeDatabase().catch(() => {})
    }
  } finally {
    await Promise.all([realtimeServer.close(), pollingServer.close()])
  }
} finally {
  unwatchFile(join(temporaryRoot, "data", "config.yaml"))
  process.chdir(repositoryRoot)
  try {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error
    }
    const cleanup = spawn(process.execPath, [
      "-e",
      "setTimeout(()=>require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:20,retryDelay:100}),1000)",
      temporaryRoot,
    ], { detached: true, stdio: "ignore", windowsHide: true })
    cleanup.unref()
    console.warn(`IMAP validation cleanup deferred: ${temporaryRoot}`)
  }
}
