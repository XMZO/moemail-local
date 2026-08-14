import { createHash, randomUUID } from "node:crypto"
import { ImapFlow, type ImapFlowOptions } from "imapflow"
import PostalMime, { addressParser, type Email as ParsedEmail } from "postal-mime"
import { z } from "zod"
import { CONFIG_KEYS } from "../config-store"
import { getDatabaseDriver, getPostgresPool, getSqlite } from "../db"
import { isSetupCompleted } from "../config/runtime"
import { normalizeMailboxAddress } from "../email-address"
import { ingestEmail, MAX_RAW_EMAIL_SIZE } from "../email-ingestion"
import { getMailuIntegration, type MailuIntegration } from "./config"

const stateFields = {
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  retentionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  uidValidity: z.string().regex(/^\d+$/u),
  lastUid: z.number().int().nonnegative(),
  initialUpperUid: z.number().int().nonnegative().optional(),
  initialFilter: z.enum(["unseen", "all"]).optional(),
  pending: z.record(z.object({
    action: z.enum(["delete", "archive"]),
    dueAt: z.number().int().nonnegative(),
  }).strict()).default({}),
}

const leaseSchema = z.object({
  owner: z.string().uuid(),
  token: z.string().uuid(),
  expiresAt: z.number().int().nonnegative(),
}).strict()

const storedStateSchema = z.object({ ...stateFields, lease: leaseSchema.optional() }).strict()

type State = z.infer<typeof storedStateSchema>
const pollerInstanceId = randomUUID()
const LEASE_MS = 300_000
let stateMutationTail: Promise<void> = Promise.resolve()

function fingerprint(integration: MailuIntegration) {
  return createHash("sha256").update(JSON.stringify({
    host: integration.imap.host,
    port: integration.imap.port,
    security: integration.imap.security,
    user: integration.collector.address,
    mailbox: integration.imap.mailbox,
    recipientHeader: integration.imap.recipientHeader,
    initialSync: integration.imap.initialSync,
  })).digest("hex")
}

function retentionFingerprint(integration: MailuIntegration) {
  return createHash("sha256")
    .update(JSON.stringify(integration.retention))
    .digest("hex")
}

async function requireCurrentIntegration(integration: MailuIntegration) {
  const current = await getMailuIntegration()
  if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(integration)) {
    throw new Error("MAILU_POLICY_CHANGED")
  }
}

function safeMailuError(error: unknown, integration: MailuIntegration | null) {
  let message = error instanceof Error ? error.message : "unknown"
  for (const secret of [
    integration?.api.token,
    integration?.collector.password,
    integration?.catchAll.password,
  ].filter((value): value is string => Boolean(value))) {
    message = message.replaceAll(secret, "[redacted]")
  }
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 300)
}

async function mutateState<T>(mutator: (state: State | null) => T, initial?: State) {
  const predecessor = stateMutationTail
  let release = () => {}
  stateMutationTail = new Promise<void>(resolve => { release = resolve })
  await predecessor.catch(() => {})
  try {
    if (getDatabaseDriver() === "postgres") {
      const client = await getPostgresPool().connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:mailu-imap-state'))")
        const selected = await client.query<{ value: string }>(
          "SELECT value FROM site_config WHERE key = $1",
          [CONFIG_KEYS.MAILU_IMAP_STATE],
        )
        const raw = selected.rows[0]?.value ?? null
        const state = raw
          ? storedStateSchema.parse(JSON.parse(raw))
          : initial ? structuredClone(initial) : null
        const result = mutator(state)
        const next = state
        if (next) {
          await client.query(`
            INSERT INTO site_config (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
          `, [CONFIG_KEYS.MAILU_IMAP_STATE, JSON.stringify(next)])
        }
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }
    return getSqlite().transaction(() => {
      const row = getSqlite().prepare(
        "SELECT value FROM site_config WHERE key = ? LIMIT 1",
      ).get(CONFIG_KEYS.MAILU_IMAP_STATE) as { value?: string } | undefined
      const state = row?.value
        ? storedStateSchema.parse(JSON.parse(row.value))
        : initial ? structuredClone(initial) : null
      const result = mutator(state)
      if (state) getSqlite().prepare(`
        INSERT INTO site_config (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(CONFIG_KEYS.MAILU_IMAP_STATE, JSON.stringify(state), Date.now())
      return result
    }).immediate()
  } finally {
    release()
  }
}

async function acquireLease(initial: State) {
  const token = randomUUID()
  const acquired = await mutateState(state => {
    if (!state) return false
    if (state.lease && state.lease.expiresAt > Date.now()) return false
    state.lease = { owner: pollerInstanceId, token, expiresAt: Date.now() + LEASE_MS }
    return true
  }, initial)
  return acquired ? token : null
}

async function releaseLease(token: string) {
  await mutateState(state => {
    if (state?.lease?.owner === pollerInstanceId && state.lease.token === token) delete state.lease
  })
}

async function saveLeasedState(state: State, token: string) {
  await mutateState(current => {
    if (!current?.lease || current.lease.owner !== pollerInstanceId || current.lease.token !== token) {
      throw new Error("MAILU_IMAP_LEASE_LOST")
    }
    const lease = { ...current.lease, expiresAt: Date.now() + LEASE_MS }
    Object.keys(current).forEach(key => delete (current as unknown as Record<string, unknown>)[key])
    Object.assign(current, state, { lease })
  })
}

export function mailuImapClientOptions(integration: MailuIntegration): ImapFlowOptions {
  return {
    host: integration.imap.host,
    port: integration.imap.port,
    secure: integration.imap.security === "tls",
    doSTARTTLS: integration.imap.security === "starttls",
    auth: { user: integration.collector.address, pass: integration.collector.password },
    tls: { rejectUnauthorized: integration.imap.rejectUnauthorized },
    logger: false,
    disableAutoIdle: true,
    disableCompression: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    maxLineLength: 1024 * 1024,
    maxLiteralSize: MAX_RAW_EMAIL_SIZE + 1,
    maxResponseSize: MAX_RAW_EMAIL_SIZE + 2 * 1024 * 1024,
    clientInfo: { name: "MoeMail Local Mailu", version: "1" },
  }
}

function clientFor(integration: MailuIntegration) {
  const client = new ImapFlow(mailuImapClientOptions(integration))
  client.on("error", () => {})
  return client
}

async function closeClient(client: ImapFlow) {
  if (!client.usable) return client.close()
  try { await client.logout() } catch { client.close() }
}

export async function testMailuImapConnection(integration: MailuIntegration) {
  const client = clientFor(integration)
  try {
    await client.connect()
    const mailbox = await client.mailboxOpen(integration.imap.mailbox, { readOnly: true })
    if (integration.retention.action === "delete" && !client.capabilities.has("UIDPLUS")) {
      throw new Error("MAILU_IMAP_SAFE_DELETE_UNAVAILABLE")
    }
    if (
      integration.retention.action === "archive"
      && !client.capabilities.has("MOVE")
      && !client.capabilities.has("UIDPLUS")
    ) throw new Error("MAILU_IMAP_SAFE_MOVE_UNAVAILABLE")
    return { ok: true as const, mailbox: mailbox.path, messages: mailbox.exists, uidValidity: mailbox.uidValidity.toString() }
  } finally {
    await closeClient(client)
  }
}

function headerValues(message: ParsedEmail, key: string) {
  return message.headers
    .filter(header => header.key?.toLowerCase() === key)
    .map(header => header.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
}

function headerAddress(value: string) {
  try {
    const addresses = addressParser(value, { flatten: true })
      .map(item => normalizeMailboxAddress(item.address ?? ""))
      .filter((item): item is string => Boolean(item))
    return addresses.length === 1 ? addresses[0] : null
  } catch {
    return null
  }
}

export function mailuEnvelopeRecipient(parsed: ParsedEmail, integration: MailuIntegration) {
  // Mailu mode never falls back to MIME To/Cc. Only the explicitly configured,
  // server-added delivery trace is accepted, and ambiguity fails closed.
  const values = headerValues(parsed, integration.imap.recipientHeader)
  if (values.length !== 1) return null
  const candidate = headerAddress(values[0])
  if (!candidate || candidate === integration.collector.address) return null
  return candidate
}

async function ingestSource(raw: Buffer, integration: MailuIntegration) {
  let parsed: ParsedEmail
  try { parsed = await PostalMime.parse(raw) } catch { return "invalid" as const }
  const envelopeTo = mailuEnvelopeRecipient(parsed, integration)
  if (!envelopeTo) return "missing-recipient" as const
  const envelopeFrom = normalizeMailboxAddress(parsed.returnPath ?? "")
    ?? normalizeMailboxAddress(parsed.from?.address ?? "")
    ?? ""
  const result = await ingestEmail({ raw, envelopeFrom, envelopeTo, transport: "mailu" })
  return result.status
}

function numericSearch(result: number[] | false) {
  return result === false ? [] : [...new Set(result.filter(uid => Number.isSafeInteger(uid) && uid > 0))].sort((a, b) => a - b)
}

async function searchBatch(client: ImapFlow, lower: number, upper: number, unseen: boolean, limit: number) {
  const boundedUpper = Math.min(upper, lower + Math.max(limit, Math.min(10_000, limit * 100)) - 1)
  const result = await client.search({ uid: `${lower}:${boundedUpper}`, ...(unseen ? { seen: false } : {}) }, { uid: true })
  if (result === false) throw new Error("MAILU_IMAP_SEARCH_FAILED")
  const uids = numericSearch(result).filter(uid => uid >= lower && uid <= boundedUpper).slice(0, limit)
  return { uids, scannedThrough: uids.length < limit ? boundedUpper : uids[uids.length - 1] }
}

async function applyRetention(client: ImapFlow, state: State, integration: MailuIntegration, leaseToken: string) {
  const due = Object.entries(state.pending)
    .filter(([, item]) => item.dueAt <= Date.now())
    .map(([uid]) => Number(uid))
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b)
  for (const uid of due) {
    await requireCurrentIntegration(integration)
    const item = state.pending[String(uid)]
    if (!item) continue
    // A crash can happen after MOVE/EXPUNGE but before state persistence. A
    // missing UID is therefore treated as an already completed idempotent
    // retention action, never as a reason to stall the cursor forever.
    const existing = await client.fetchOne(String(uid), { flags: true }, { uid: true })
    if (existing === false) {
      delete state.pending[String(uid)]
      await saveLeasedState(state, leaseToken)
      continue
    }
    if (item.action === "delete") {
      // ImapFlow falls back to plain EXPUNGE when UIDPLUS is unavailable.
      // That command expunges every message another client may already have
      // marked as Deleted, not just this UID, so fail closed instead.
      if (!client.capabilities.has("UIDPLUS")) throw new Error("MAILU_IMAP_SAFE_DELETE_UNAVAILABLE")
      await requireCurrentIntegration(integration)
      const deleted = await client.messageDelete(String(uid), { uid: true })
      if (!deleted) throw new Error(`MAILU_IMAP_DELETE_FAILED:${uid}`)
    } else {
      // Native MOVE is UID-scoped. Its COPY+EXPUNGE fallback has the same
      // unsafe plain-EXPUNGE behavior unless UIDPLUS is available.
      if (!client.capabilities.has("MOVE") && !client.capabilities.has("UIDPLUS")) {
        throw new Error("MAILU_IMAP_SAFE_MOVE_UNAVAILABLE")
      }
      let moved
      try {
        await requireCurrentIntegration(integration)
        moved = await client.messageMove(String(uid), integration.retention.action === "archive" ? integration.retention.mailbox : "", { uid: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        if (!/TRYCREATE|NONEXISTENT|does not exist/iu.test(message)) throw error
        if (integration.retention.action !== "archive") throw error
        await client.mailboxCreate(integration.retention.mailbox).catch(createError => {
          if (!/exist/iu.test(createError instanceof Error ? createError.message : "")) throw createError
        })
        await requireCurrentIntegration(integration)
        moved = await client.messageMove(String(uid), integration.retention.mailbox, { uid: true })
      }
      if (!moved) throw new Error(`MAILU_IMAP_ARCHIVE_FAILED:${uid}`)
    }
    delete state.pending[String(uid)]
    await saveLeasedState(state, leaseToken)
  }
}

async function pollMailuIntegrationUnlocked(integration: MailuIntegration, leaseToken: string) {
  await requireCurrentIntegration(integration)
  const client = clientFor(integration)
  try {
    await client.connect()
    const mailbox = await client.mailboxOpen(integration.imap.mailbox, { readOnly: integration.retention.action === "keep" })
    const uidValidity = mailbox.uidValidity.toString()
    const upperUid = Math.max(0, mailbox.uidNext - 1)
    const currentFingerprint = fingerprint(integration)
    const currentRetentionFingerprint = retentionFingerprint(integration)
    // Use the state snapshot carried by this lease token. Reading it outside
    // mutateState here would allow another process to replace the document
    // between the read and save, while our later lease check only proves the
    // token survived. The lease acquisition itself was serialized by the DB.
    let state = await mutateState(current => {
      if (!current?.lease || current.lease.owner !== pollerInstanceId || current.lease.token !== leaseToken) {
        throw new Error("MAILU_IMAP_LEASE_LOST")
      }
      return structuredClone(current)
    })
    if (!state) throw new Error("MAILU_IMAP_STATE_INVALID")
    if (!state || state.fingerprint !== currentFingerprint) {
      state = {
        version: 1,
        fingerprint: currentFingerprint,
        retentionFingerprint: currentRetentionFingerprint,
        uidValidity,
        lastUid: integration.imap.initialSync === "new" ? upperUid : 0,
        ...(integration.imap.initialSync === "unseen" && upperUid > 0 ? { initialUpperUid: upperUid, initialFilter: "unseen" as const } : {}),
        pending: {},
      }
      await saveLeasedState(state, leaseToken)
      if (integration.imap.initialSync === "new") return { processed: 0, initialized: true }
    }
    if (state.uidValidity !== uidValidity) {
      state = { version: 1, fingerprint: currentFingerprint, retentionFingerprint: currentRetentionFingerprint, uidValidity, lastUid: 0, initialUpperUid: upperUid, initialFilter: "all", pending: {} }
      await saveLeasedState(state, leaseToken)
    }

    // Retention is deliberately independent from the mailbox cursor. A policy
    // change cancels destructive work queued by the old policy without
    // reinitializing `lastUid` (which could skip mail when initialSync=new).
    if (state.retentionFingerprint !== currentRetentionFingerprint) {
      state.retentionFingerprint = currentRetentionFingerprint
      state.pending = {}
      await saveLeasedState(state, leaseToken)
    }

    if (integration.retention.action !== "keep") await applyRetention(client, state, integration, leaseToken)
    const scanUpper = state.initialUpperUid ?? upperUid
    if (state.lastUid >= scanUpper) return { processed: 0, initialized: false }
    const batch = await searchBatch(client, state.lastUid + 1, scanUpper, state.initialFilter === "unseen", integration.imap.maxMessagesPerPoll)
    let processed = 0
    for (const uid of batch.uids) {
      await requireCurrentIntegration(integration)
      const metadata = await client.fetchOne(String(uid), { size: true }, { uid: true })
      if (!metadata || (metadata.size ?? 0) > MAX_RAW_EMAIL_SIZE) {
        state.lastUid = uid
        await saveLeasedState(state, leaseToken)
        continue
      }
      const fetched = await client.fetchOne(String(uid), { source: { maxLength: MAX_RAW_EMAIL_SIZE + 1 } }, { uid: true })
      if (fetched === false || !fetched.source || fetched.source.byteLength > MAX_RAW_EMAIL_SIZE) throw new Error(`MAILU_IMAP_SOURCE_FAILED:${uid}`)
      const outcome = await ingestSource(fetched.source, integration)
      await requireCurrentIntegration(integration)
      // Only a durable MoeMail row (created) or a proven duplicate may advance
      // into destructive retention. Invalid/unknown catch-all messages remain
      // upstream for inspection, but still advance the cursor so one bad message
      // cannot starve every valid message behind it.
      if ((outcome === "created" || outcome === "duplicate") && integration.retention.action !== "keep") {
        state.pending[String(uid)] = {
          action: integration.retention.action,
          dueAt: Date.now() + integration.retention.delaySeconds * 1_000,
        }
      }
      state.lastUid = uid
      await saveLeasedState(state, leaseToken)
      if (outcome === "created" || outcome === "duplicate") processed += 1
      else console.warn(JSON.stringify({ event: "mailu.imap.message_skipped", uid, outcome }))
    }
    if (state.lastUid < batch.scannedThrough) state.lastUid = batch.scannedThrough
    if (state.lastUid >= scanUpper) {
      delete state.initialUpperUid
      delete state.initialFilter
    }
    await saveLeasedState(state, leaseToken)
    if (integration.retention.action !== "keep") await applyRetention(client, state, integration, leaseToken)
    return { processed, initialized: false }
  } finally {
    await closeClient(client)
  }
}

export async function pollMailuIntegration(integration: MailuIntegration) {
  // A deliberately different fingerprint makes the lock holder initialize
  // the real cursor from the selected mailbox. Initialization and lease
  // creation happen in one serialized mutation, so another process cannot
  // overwrite a live lease while seeding an empty state document.
  const seed: State = {
    version: 1,
    fingerprint: "0".repeat(64),
    uidValidity: "0",
    lastUid: 0,
    pending: {},
  }
  const leaseToken = await acquireLease(seed)
  if (!leaseToken) return { processed: 0, initialized: false, skipped: true }
  try {
    return await pollMailuIntegrationUnlocked(integration, leaseToken)
  } finally {
    await releaseLease(leaseToken).catch(() => {})
  }
}

const globalState = globalThis as typeof globalThis & { __moemailMailuPoller?: AbortController }

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

async function loop(signal: AbortSignal) {
  while (!signal.aborted) {
    let delay = 5_000
    let integration: MailuIntegration | null = null
    try {
      if (!isSetupCompleted()) {
        await wait(delay, signal)
        continue
      }
      integration = await getMailuIntegration()
      if (integration?.enabled) {
        await pollMailuIntegration(integration)
        delay = integration.imap.pollIntervalSeconds * 1_000
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "mailu.imap.failed",
        incidentId: randomUUID(),
        message: safeMailuError(error, integration),
      }))
    }
    await wait(delay, signal)
  }
}

export function startMailuPoller() {
  if (globalState.__moemailMailuPoller) return
  const controller = new AbortController()
  globalState.__moemailMailuPoller = controller
  void loop(controller.signal)
}
