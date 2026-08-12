import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server, type Socket } from "node:net"
import { cpSync, mkdtempSync, rmSync, unwatchFile } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { eq } from "drizzle-orm"

const repositoryRoot = process.cwd()
const temporaryRoot = mkdtempSync(join(tmpdir(), "moemail-imap-inbound-"))
const postgresUrl = process.argv
  .find(argument => argument.startsWith("--postgres-url="))
  ?.slice("--postgres-url=".length) ?? null

const rawMessage = Buffer.from([
  "Return-Path: <sender@example.net>",
  "Delivered-To: provider-account@example.net",
  "X-Original-To: inbox@imap-validation.example",
  // A sender can include the same header name in the RFC822 payload. The
  // provider-prepended first trace must remain authoritative.
  "X-Original-To: forged@imap-validation.example",
  "From: sender@example.net",
  // Sender-controlled MIME recipients must not override the provider-added
  // original-recipient trace above.
  "To: forged@imap-validation.example",
  "Subject: IMAP inbound integration",
  "Message-ID: <imap-validation@example.net>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "imap inbound marker",
].join("\r\n"))

function quote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function createMockImapServer(): Promise<{
  server: Server
  port: number
  commands: string[]
  setUidValidity: (value: number) => void
}> {
  const commands: string[] = []
  const state = { uidValidity: 777 }
  const server = createServer(socket => handleConnection(socket, commands, state))
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
      })
    })
  })
}

function handleConnection(
  socket: Socket,
  commands: string[],
  state: { uidValidity: number },
) {
  socket.setNoDelay(true)
  socket.write("* OK [CAPABILITY IMAP4rev1 ID ENABLE NAMESPACE] mock ready\r\n")
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
      const [tag = "", rawCommand = ""] = line.split(" ", 2)
      const command = rawCommand.toUpperCase()
      const ok = (message: string) => socket.write(`${tag} OK ${message}\r\n`)

      switch (command) {
        case "CAPABILITY":
          socket.write("* CAPABILITY IMAP4rev1 ID ENABLE NAMESPACE\r\n")
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
          socket.write("* 1 EXISTS\r\n")
          socket.write("* FLAGS (\\Seen)\r\n")
          socket.write(`* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid\r\n`)
          socket.write("* OK [UIDNEXT 2] next UID\r\n")
          ok("[READ-ONLY] selected")
          break
        case "UID": {
          const upper = line.toUpperCase()
          if (upper.includes(" SEARCH ")) {
            socket.write("* SEARCH 1\r\n")
            ok("SEARCH completed")
          } else if (upper.includes(" FETCH ") && upper.includes("RFC822.SIZE")) {
            socket.write(`* 1 FETCH (UID 1 RFC822.SIZE ${rawMessage.byteLength})\r\n`)
            ok("FETCH completed")
          } else if (upper.includes(" FETCH ")) {
            socket.write(`* 1 FETCH (UID 1 BODY[] {${rawMessage.byteLength}}\r\n`)
            socket.write(rawMessage)
            socket.write(")\r\n")
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

  const { server, port, commands, setUidValidity } = await createMockImapServer()
  try {
    const domains = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/domain-policies.ts")).href)
    const database = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/db.ts")).href)
    const schema = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/schema.ts")).href)
    const imap = await import(pathToFileURL(resolve(repositoryRoot, "app/lib/imap-inbound.ts")).href)

    const inbound = {
      mode: "imap" as const,
      host: "127.0.0.1",
      port,
      security: "plain" as const,
      username: "imap-user",
      password: "imap-password",
      rejectUnauthorized: true,
      mailbox: "INBOX",
      recipientHeader: "auto" as const,
      initialSync: "unseen" as const,
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 10,
    }
    const [policy] = await domains.saveDomainPolicies([{
      domain: "imap-validation.example",
      inbound,
      outbound: { mode: "disabled" },
    }])

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

    const connection = await imap.testImapConnection(inbound)
    assert.equal(connection.ok, true)
    assert.equal(connection.messages, 1)
    const first = await imap.pollImapDomain(policy)
    assert.equal(first.processed, 1)
    const second = await imap.pollImapDomain(policy)
    assert.equal(second.processed, 0)

    // Servers may reset and reuse UIDs after a mailbox rebuild. The poller must
    // rescan without duplicating content, then settle on the new UIDVALIDITY.
    setUidValidity(778)
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
    assert.match(stored[0].content, /imap inbound marker/)
    assert.equal(commands.some(command => /\bSTORE\b|\bMOVE\b|\bCOPY\b|\bEXPUNGE\b/i.test(command)), false)
    assert.ok(commands.some(command => /\bEXAMINE\b/i.test(command)))

    await database.closeDatabase()
    console.log(JSON.stringify({
      realImapConversation: true,
      databaseDriver: postgresUrl ? "postgres" : "sqlite",
      postgresPoolMaxOneLease: Boolean(postgresUrl),
      originalRecipientHeaderResolved: true,
      forgedMimeRecipientIgnored: true,
      persistentUidCursorDeduplicates: true,
      uidValidityResetRescansSafely: true,
      upstreamMailboxRemainsReadOnly: true,
    }))
  } finally {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
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
