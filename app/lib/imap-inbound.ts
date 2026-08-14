import { createHash, randomUUID } from "node:crypto"
import { ImapFlow, type ImapFlowOptions } from "imapflow"
import type { PoolClient } from "pg"
import PostalMime, { addressParser, type Email as ParsedEmail } from "postal-mime"
import { z } from "zod"
import { CONFIG_KEYS, getConfigValue, setConfigValues } from "./config-store"
import { isSetupCompleted } from "./config/runtime"
import { getDatabaseDriver, getPostgresPool } from "./db"
import {
  getDomainPolicies,
  type DomainPolicy,
} from "./domain-policies"
import {
  ingestEmail,
  inspectInboundRecipient,
  MAX_RAW_EMAIL_SIZE,
} from "./email-ingestion"
import { normalizeMailboxAddress } from "./email-address"

type ImapPolicy = Extract<DomainPolicy["inbound"], { mode: "imap" }>
type ImapDomainPolicy = DomainPolicy & { inbound: ImapPolicy }

const CONFIG_CHECK_MS = 5_000
const MAX_CONCURRENT_ACCOUNTS = 4
const MAX_REALTIME_ACCOUNTS = 32
// Covers the connection, bounded SEARCH/FETCH, MIME parsing and the configured
// webhook retry window for one message. A crashed worker is reclaimed later.
const ACCOUNT_LEASE_MS = 300_000
const pollerInstanceId = randomUUID()

const accountStateSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  uidValidity: z.string().regex(/^\d+$/),
  lastUid: z.number().int().min(0),
  initialUpperUid: z.number().int().min(0).optional(),
  initialFilter: z.enum(["unseen", "all"]).optional(),
}).strict()

const accountLeaseSchema = z.object({
  owner: z.string().uuid(),
  token: z.string().uuid(),
  expiresAt: z.number().int().nonnegative(),
}).strict()

const syncStateSchema = z.object({
  version: z.literal(1),
  accounts: z.record(accountStateSchema),
  leases: z.record(accountLeaseSchema).default({}),
}).strict()

type AccountState = z.infer<typeof accountStateSchema>
type SyncState = z.infer<typeof syncStateSchema>

const emptySyncState = (): SyncState => ({ version: 1, accounts: {}, leases: {} })
let stateMutationTail: Promise<void> = Promise.resolve()

function safeError(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : "unknown"
  for (const secret of secrets.filter(Boolean)) {
    message = message.replaceAll(secret, "[redacted]")
  }
  return message.replace(/[\r\n\0]+/g, " ").slice(0, 500)
}

function policyFingerprint(domain: string, policy: ImapPolicy) {
  return createHash("sha256")
    .update(JSON.stringify({
      domain,
      host: policy.host,
      port: policy.port,
      security: policy.security,
      username: policy.username,
      mailbox: policy.mailbox,
      recipientHeader: policy.recipientHeader,
      initialSync: policy.initialSync,
    }))
    .digest("hex")
}

async function requireCurrentPolicy(policy: ImapDomainPolicy) {
  const current = await getDomainPolicies()
    .then(policies => policies.find(candidate => candidate.domain === policy.domain))
  if (
    !current
    || current.inbound.mode !== "imap"
    || JSON.stringify(current.inbound) !== JSON.stringify(policy.inbound)
  ) {
    throw new Error("IMAP_POLICY_CHANGED")
  }
}

async function readSyncState(): Promise<SyncState> {
  const raw = await getConfigValue(CONFIG_KEYS.IMAP_SYNC_STATE)
  return parseSyncState(raw)
}

function parseSyncState(raw: string | null): SyncState {
  if (!raw) return emptySyncState()
  try {
    return syncStateSchema.parse(JSON.parse(raw))
  } catch {
    // Never turn damaged progress into an empty cursor: initialSync=new would
    // then jump to the current high-water mark and silently lose mail.
    throw new Error("IMAP_SYNC_STATE_INVALID")
  }
}

async function mutatePostgresSyncState<T>(
  client: PoolClient,
  mutator: (state: SyncState) => T,
): Promise<T> {
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('moemail:imap-state'))")
    const selected = await client.query<{ value: string }>(
      "SELECT value FROM site_config WHERE key = $1",
      [CONFIG_KEYS.IMAP_SYNC_STATE],
    )
    const state = parseSyncState(selected.rows[0]?.value ?? null)
    const result = mutator(state)
    await client.query(
      `INSERT INTO site_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [CONFIG_KEYS.IMAP_SYNC_STATE, JSON.stringify(state)],
    )
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  }
}

async function mutateSyncState<T>(mutator: (state: SyncState) => T): Promise<T> {
  const predecessor = stateMutationTail
  let release = () => {}
  stateMutationTail = new Promise<void>(resolve => { release = resolve })
  await predecessor.catch(() => {})
  try {
    if (getDatabaseDriver() === "postgres") {
      const client = await getPostgresPool().connect()
      try {
        return await mutatePostgresSyncState(client, mutator)
      } finally {
        client.release()
      }
    }
    const state = await readSyncState()
    const result = mutator(state)
    await setConfigValues({
      [CONFIG_KEYS.IMAP_SYNC_STATE]: JSON.stringify(state),
    })
    return result
  } finally {
    release()
  }
}

function renewAccountLease(state: SyncState, domain: string, token?: string) {
  if (!token) return
  const lease = state.leases[domain]
  if (!lease || lease.owner !== pollerInstanceId || lease.token !== token) {
    throw new Error("IMAP_POLL_LEASE_LOST")
  }
  lease.expiresAt = Date.now() + ACCOUNT_LEASE_MS
}

async function acquireAccountLease(domain: string) {
  const token = randomUUID()
  return mutateSyncState(state => {
    const now = Date.now()
    const current = state.leases[domain]
    if (current && current.expiresAt > now) return null
    state.leases[domain] = {
      owner: pollerInstanceId,
      token,
      expiresAt: now + ACCOUNT_LEASE_MS,
    }
    return token
  })
}

async function releaseAccountLease(domain: string, token: string) {
  await mutateSyncState(state => {
    const current = state.leases[domain]
    if (current?.owner === pollerInstanceId && current.token === token) {
      delete state.leases[domain]
    }
  })
}

async function saveAccountState(domain: string, account: AccountState, leaseToken?: string) {
  await mutateSyncState(state => {
    renewAccountLease(state, domain, leaseToken)
    state.accounts[domain] = account
  })
}

async function pruneAccountStates(domains: Set<string>) {
  await mutateSyncState(state => {
    for (const domain of Object.keys(state.accounts)) {
      if (!domains.has(domain)) delete state.accounts[domain]
    }
    for (const domain of Object.keys(state.leases)) {
      if (!domains.has(domain)) delete state.leases[domain]
    }
  })
}

export function createImapClientOptions(policy: ImapPolicy, realtime = false): ImapFlowOptions {
  const connectionTimeout = policy.connectionTimeoutSeconds * 1_000
  const idleRenew = policy.realtime.idleRenewSeconds * 1_000
  return {
    host: policy.host,
    port: policy.port,
    secure: policy.security === "tls",
    doSTARTTLS: policy.security === "starttls",
    auth: { user: policy.username, pass: policy.password },
    tls: { rejectUnauthorized: policy.rejectUnauthorized },
    logger: false,
    disableAutoIdle: true,
    ...(realtime ? { maxIdleTime: idleRenew } : {}),
    disableCompression: true,
    connectionTimeout,
    greetingTimeout: connectionTimeout,
    socketTimeout: realtime
      ? Math.max(idleRenew + 60_000, connectionTimeout * 2)
      : Math.max(30_000, connectionTimeout),
    maxLineLength: 1024 * 1024,
    maxLiteralSize: MAX_RAW_EMAIL_SIZE + 1,
    maxResponseSize: MAX_RAW_EMAIL_SIZE + 2 * 1024 * 1024,
    clientInfo: { name: "MoeMail Local", version: "1" },
  }
}

function createClient(policy: ImapPolicy, realtime = false) {
  const client = new ImapFlow(createImapClientOptions(policy, realtime))
  // ImapFlow is an EventEmitter. Keep transport errors on the promise/log path
  // instead of allowing an unhandled `error` event to terminate Next.js.
  client.on("error", () => {})
  return client
}

async function closeClient(client: ImapFlow) {
  if (!client.usable) {
    client.close()
    return
  }
  try {
    await client.logout()
  } catch {
    client.close()
  }
}

export async function testImapConnection(policy: ImapPolicy) {
  const client = createClient(policy)
  try {
    await client.connect()
    const mailbox = await client.mailboxOpen(policy.mailbox, { readOnly: true })
    return {
      ok: true as const,
      mailbox: mailbox.path,
      messages: mailbox.exists,
      uidValidity: mailbox.uidValidity.toString(),
      idleSupported: client.capabilities.has("IDLE"),
    }
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

function addressesFromHeader(value: string) {
  try {
    return addressParser(value, { flatten: true })
      .map(entry => normalizeMailboxAddress(entry.address ?? ""))
      .filter((address): address is string => Boolean(address))
  } catch {
    return []
  }
}

function recipientCandidates(message: ParsedEmail, policy: ImapDomainPolicy) {
  const headerOrder = policy.inbound.recipientHeader === "auto"
    ? ["x-original-to", "envelope-to", "x-envelope-to", "delivered-to"]
    : [policy.inbound.recipientHeader]
  for (const header of headerOrder) {
    for (const value of headerValues(message, header)) {
      const candidate = addressesFromHeader(value)
        .find(address => address.endsWith(`@${policy.domain}`))
      // Provider trace headers are normally prepended. Taking exactly the
      // first matching value prevents a sender-supplied duplicate header from
      // copying one SMTP delivery into additional local mailboxes.
      if (candidate) return [candidate]
    }
  }
  return []
}

async function ingestImapSource(raw: Buffer, policy: ImapDomainPolicy) {
  let parsed: ParsedEmail
  try {
    parsed = await PostalMime.parse(raw)
  } catch {
    return { outcome: "invalid-message" }
  }

  const candidates = recipientCandidates(parsed, policy)
  const recipients: string[] = []
  for (const candidate of candidates) {
    const inspection = await inspectInboundRecipient(candidate, "imap")
    if (inspection.accepted) recipients.push(inspection.normalizedAddress)
  }
  if (recipients.length === 0) return { outcome: "no-local-recipient" }

  const envelopeFrom = normalizeMailboxAddress(parsed.returnPath ?? "")
    ?? normalizeMailboxAddress(parsed.from?.address ?? "")
    ?? ""
  let created = 0
  let duplicate = 0
  let rejected = 0
  for (const envelopeTo of recipients) {
    const result = await ingestEmail({
      raw,
      envelopeFrom,
      envelopeTo,
      transport: "imap",
    })
    if (result.status === "created") created += 1
    if (result.status === "duplicate") duplicate += 1
    if (result.status === "rejected") rejected += 1
  }
  return {
    outcome: created > 0
      ? "created"
      : duplicate > 0
        ? "duplicate"
        : rejected > 0
          ? "rejected"
          : "ignored",
  }
}

function numericSearchResult(result: number[] | false) {
  return result === false
    ? []
    : [...new Set(result.filter(uid => Number.isSafeInteger(uid) && uid > 0))].sort((a, b) => a - b)
}

function expandUidSequenceSet(value: string, limit: number) {
  const result: number[] = []
  for (const part of value.split(",")) {
    if (!part) continue
    const [startRaw, endRaw = startRaw] = part.split(":", 2)
    if (!/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw)) continue
    const start = Number(startRaw)
    const end = Number(endRaw)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue
    const lower = Math.min(start, end)
    const upper = Math.max(start, end)
    for (let uid = lower; uid <= upper && result.length < limit; uid += 1) {
      if (uid > 0) result.push(uid)
    }
    if (result.length >= limit) break
  }
  return [...new Set(result)].sort((a, b) => a - b).slice(0, limit)
}

async function searchUidBatch(
  client: ImapFlow,
  lowerUid: number,
  upperUid: number,
  unseenOnly: boolean,
  limit: number,
) {
  const fullQuery = {
    uid: `${lowerUid}:${upperUid}`,
    ...(unseenOnly ? { seen: false } : {}),
  }
  if (client.capabilities.has("ESEARCH") && client.capabilities.has("PARTIAL")) {
    const result = await client.search(fullQuery, {
      uid: true,
      returnOptions: ["COUNT", { partial: `1:${limit}` }],
    })
    if (result === false) throw new Error("IMAP_UID_SEARCH_FAILED")
    if (!Array.isArray(result)) {
      if (typeof result.count !== "number") {
        throw new Error("IMAP_ESEARCH_COUNT_MISSING")
      }
      if (result.count === 0) return { uids: [], scannedThrough: upperUid }
      if (!result.partial) {
        throw new Error("IMAP_ESEARCH_PARTIAL_MISSING")
      }
      const uids = expandUidSequenceSet(result.partial.messages, limit)
        .filter(uid => uid >= lowerUid && uid <= upperUid)
      if (uids.length === 0) {
        throw new Error("IMAP_ESEARCH_PARTIAL_INVALID")
      }
      return {
        uids,
        scannedThrough: result.count <= uids.length ? upperUid : uids[uids.length - 1],
      }
    }
    const uids = numericSearchResult(result)
      .filter(uid => uid >= lowerUid && uid <= upperUid)
      .slice(0, limit)
    return {
      uids,
      scannedThrough: uids.length < limit ? upperUid : uids[uids.length - 1],
    }
  }

  // Legacy SEARCH has no result paging. Bound the numeric UID window so a
  // large mailbox cannot force one response containing every matching UID.
  const uidWindow = Math.max(limit, Math.min(10_000, limit * 100))
  const fallbackUpper = Math.min(upperUid, lowerUid + uidWindow - 1)
  const fallbackQuery = {
    uid: `${lowerUid}:${fallbackUpper}`,
    ...(unseenOnly ? { seen: false } : {}),
  }
  const result = await client.search(fallbackQuery, { uid: true })
  if (result === false) throw new Error("IMAP_UID_SEARCH_FAILED")
  const uids = numericSearchResult(result)
    .filter(uid => uid >= lowerUid && uid <= fallbackUpper)
    .slice(0, limit)
  return {
    uids,
    scannedThrough: uids.length < limit ? fallbackUpper : uids[uids.length - 1],
  }
}

function initialAccountState(
  policy: ImapDomainPolicy,
  uidValidity: string,
  upperUid: number,
): AccountState {
  const base: AccountState = {
    fingerprint: policyFingerprint(policy.domain, policy.inbound),
    uidValidity,
    lastUid: upperUid,
  }
  if (policy.inbound.initialSync === "new" || upperUid === 0) return base

  return {
    ...base,
    lastUid: 0,
    initialUpperUid: upperUid,
    initialFilter: "unseen",
  }
}

async function pollImapDomainUnlocked(policy: ImapDomainPolicy, leaseToken?: string) {
  const client = createClient(policy.inbound)
  try {
    await requireCurrentPolicy(policy)
    await client.connect()
    const mailbox = await client.mailboxOpen(policy.inbound.mailbox, { readOnly: true })
    await requireCurrentPolicy(policy)
    const uidValidity = mailbox.uidValidity.toString()
    const upperUid = Math.max(0, mailbox.uidNext - 1)
    const fingerprint = policyFingerprint(policy.domain, policy.inbound)
    const stored = (await readSyncState()).accounts[policy.domain]
    let account = stored

    if (!account || account.fingerprint !== fingerprint) {
      account = initialAccountState(policy, uidValidity, upperUid)
      await saveAccountState(policy.domain, account, leaseToken)
      console.log(JSON.stringify({
        event: "imap.account.initialized",
        domain: policy.domain,
        mailbox: policy.inbound.mailbox,
        initialSync: policy.inbound.initialSync,
      }))
      if (policy.inbound.initialSync === "new" || !account.initialUpperUid) {
        return { processed: 0, initialized: true, hasMore: false }
      }
    }
    if (account.uidValidity !== uidValidity) {
      // UID values may be reused after UIDVALIDITY changes. Rescan the current
      // mailbox in bounded batches and rely on the content hash for dedupe so a
      // server reset cannot silently skip mail received around the transition.
      account = {
        fingerprint,
        uidValidity,
        lastUid: 0,
        initialUpperUid: upperUid,
        initialFilter: "all",
      }
      await saveAccountState(policy.domain, account, leaseToken)
      console.log(JSON.stringify({ event: "imap.uidvalidity.changed", domain: policy.domain }))
    }

    const scanUpperUid = account.initialUpperUid ?? upperUid
    if (account.lastUid >= scanUpperUid) {
      if (account.initialUpperUid !== undefined) {
        account = { ...account, lastUid: scanUpperUid }
        delete account.initialUpperUid
        delete account.initialFilter
        await saveAccountState(policy.domain, account, leaseToken)
      }
      return { processed: 0, initialized: false, hasMore: false }
    }

    const batch = await searchUidBatch(
      client,
      account.lastUid + 1,
      scanUpperUid,
      account.initialFilter === "unseen",
      policy.inbound.maxMessagesPerPoll,
    )
    const candidates = batch.uids

    let processed = 0
    for (const uid of candidates) {
      const metadata = await client.fetchOne(String(uid), { size: true }, { uid: true })
      if (!metadata) {
        account.lastUid = uid
        await saveAccountState(policy.domain, account, leaseToken)
        continue
      }
      if ((metadata.size ?? 0) > MAX_RAW_EMAIL_SIZE) {
        console.error(JSON.stringify({
          event: "imap.message.skipped",
          domain: policy.domain,
          uid,
          reason: "message-too-large",
        }))
        account.lastUid = uid
        await saveAccountState(policy.domain, account, leaseToken)
        continue
      }

      const fetched = await client.fetchOne(
        String(uid),
        { source: { maxLength: MAX_RAW_EMAIL_SIZE + 1 } },
        { uid: true },
      )
      if (fetched === false || !fetched.source) {
        throw new Error(`IMAP_RFC822_SOURCE_MISSING:${uid}`)
      }
      if (fetched.source.byteLength > MAX_RAW_EMAIL_SIZE) {
        account.lastUid = uid
        await saveAccountState(policy.domain, account, leaseToken)
        continue
      }

      await requireCurrentPolicy(policy)
      const result = await ingestImapSource(fetched.source, policy)
      if (result.outcome === "rejected") {
        console.error(JSON.stringify({
          event: "imap.message.skipped",
          domain: policy.domain,
          uid,
          reason: "recipient-policy-or-quota",
        }))
      }
      account.lastUid = uid
      await saveAccountState(policy.domain, account, leaseToken)
      processed += 1
    }

    if (account.lastUid < batch.scannedThrough) {
      account.lastUid = batch.scannedThrough
    }
    if (account.lastUid >= scanUpperUid && account.initialUpperUid !== undefined) {
      delete account.initialUpperUid
      delete account.initialFilter
    }
    if (account.lastUid >= batch.scannedThrough) {
      await saveAccountState(policy.domain, account, leaseToken)
    }

    return {
      processed,
      initialized: false,
      hasMore: account.lastUid < scanUpperUid,
    }
  } finally {
    await closeClient(client)
  }
}

export async function pollImapDomain(policy: ImapDomainPolicy) {
  if (getDatabaseDriver() !== "postgres") return pollImapDomainUnlocked(policy)
  const leaseToken = await acquireAccountLease(policy.domain)
  if (!leaseToken) return { processed: 0, initialized: false, hasMore: false, skipped: true }
  try {
    return await pollImapDomainUnlocked(policy, leaseToken)
  } finally {
    await releaseAccountLease(policy.domain, leaseToken).catch(() => {})
  }
}

type PollerRuntime = { controller: AbortController; promise: Promise<void> }
type RealtimeRuntime = {
  signature: string
  controller: AbortController
  promise: Promise<void>
}
type RealtimeOutcome = {
  reason: "aborted" | "disconnected" | "unsupported"
  connectedMilliseconds: number
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, milliseconds))
    timer.unref()
    signal.addEventListener("abort", finish, { once: true })
  })
}

function createWakeSignal() {
  const waiters = new Set<() => void>()
  return {
    notify() {
      for (const resolve of waiters) resolve()
      waiters.clear()
    },
    async wait(milliseconds: number, signal: AbortSignal) {
      if (signal.aborted || milliseconds <= 0) return
      await new Promise<void>(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          waiters.delete(finish)
          signal.removeEventListener("abort", finish)
          resolve()
        }
        const timer = setTimeout(finish, milliseconds)
        timer.unref()
        waiters.add(finish)
        signal.addEventListener("abort", finish, { once: true })
      })
    },
  }
}

function realtimeSignature(policy: ImapDomainPolicy) {
  return JSON.stringify(policy.inbound)
}

function logPollFailure(error: unknown, policy: ImapDomainPolicy, trigger: string) {
  console.error(JSON.stringify({
    event: "imap.poll.failed",
    domain: policy.domain,
    trigger,
    message: safeError(error, [policy.inbound.password, policy.inbound.username]),
  }))
}

async function runRealtimeSession(
  policy: ImapDomainPolicy,
  signal: AbortSignal,
  requestImmediate: (domain: string, trigger: string) => void,
): Promise<RealtimeOutcome> {
  const client = createClient(policy.inbound, true)
  const connectedAt = Date.now()
  let connectionError: unknown = null
  let sessionEnded = false
  let resolveSessionEnd = () => {}
  const sessionEnd = new Promise<void>(resolve => { resolveSessionEnd = resolve })
  const endSession = () => {
    if (sessionEnded) return
    sessionEnded = true
    resolveSessionEnd()
  }
  const onError = (error: unknown) => {
    connectionError = error
    endSession()
  }
  const onExists = (event: { count: number; prevCount: number }) => {
    if (event.count > event.prevCount) requestImmediate(policy.domain, "idle")
  }
  const onAbort = () => {
    endSession()
    client.close()
  }
  client.on("error", onError)
  client.on("close", endSession)
  signal.addEventListener("abort", onAbort, { once: true })

  try {
    await requireCurrentPolicy(policy)
    await client.connect()
    await client.mailboxOpen(policy.inbound.mailbox, { readOnly: true })
    await requireCurrentPolicy(policy)
    if (!client.capabilities.has("IDLE")) {
      console.warn(JSON.stringify({
        event: "imap.realtime.unsupported",
        domain: policy.domain,
        mode: "idle",
      }))
      return { reason: "unsupported", connectedMilliseconds: Date.now() - connectedAt }
    }

    client.on("exists", onExists)
    void client.idle()
      .then(result => {
        if (result === false && !connectionError) connectionError = new Error("IMAP_IDLE_ENDED")
        endSession()
      })
      .catch(onError)

    console.log(JSON.stringify({
      event: "imap.realtime.connected",
      domain: policy.domain,
      mode: "idle",
      mailbox: policy.inbound.mailbox,
    }))
    // The periodic scheduler established the UID baseline before opening this
    // listener. This pass closes the small gap between that snapshot and
    // EXAMINE without changing the initial-sync semantics.
    requestImmediate(policy.domain, "startup-gap")
    await sessionEnd

    if (signal.aborted) {
      return { reason: "aborted", connectedMilliseconds: Date.now() - connectedAt }
    }
    if (connectionError) logPollFailure(connectionError, policy, "idle")
    return { reason: "disconnected", connectedMilliseconds: Date.now() - connectedAt }
  } finally {
    signal.removeEventListener("abort", onAbort)
    client.off("exists", onExists)
    client.off("error", onError)
    client.off("close", endSession)
    await closeClient(client)
  }
}

async function runRealtimeSupervisor(
  policy: ImapDomainPolicy,
  signal: AbortSignal,
  requestImmediate: (domain: string, trigger: string) => void,
  markDormant: (domain: string, signature: string) => void,
) {
  const reconnectMin = policy.inbound.realtime.reconnectMinSeconds * 1_000
  const reconnectMax = policy.inbound.realtime.reconnectMaxSeconds * 1_000
  let reconnectDelay = reconnectMin

  while (!signal.aborted) {
    let outcome: RealtimeOutcome
    try {
      outcome = await runRealtimeSession(policy, signal, requestImmediate)
    } catch (error) {
      logPollFailure(error, policy, "idle-connect")
      outcome = { reason: "disconnected", connectedMilliseconds: 0 }
    }
    if (outcome.reason === "aborted") return
    if (outcome.reason === "unsupported") {
      // Remember the exact policy instead of repeatedly probing a capability
      // the server denied. Do not consume one of the bounded listener slots;
      // the central periodic scheduler remains active for this account.
      markDormant(policy.domain, realtimeSignature(policy))
      return
    }

    requestImmediate(policy.domain, "reconnect-gap")
    if (!policy.inbound.realtime.reconnect) {
      // An administrator-disabled reconnect must not reserve an empty listener
      // slot after the socket closes. Any policy edit makes it eligible again.
      markDormant(policy.domain, realtimeSignature(policy))
      return
    }
    if (outcome.connectedMilliseconds >= 60_000) reconnectDelay = reconnectMin
    console.warn(JSON.stringify({
      event: "imap.realtime.reconnect_scheduled",
      domain: policy.domain,
      delayMilliseconds: reconnectDelay,
    }))
    await wait(reconnectDelay, signal)
    reconnectDelay = Math.min(reconnectMax, reconnectDelay * 2)
  }
}

async function runPoller(signal: AbortSignal) {
  const nextPollAt = new Map<string, number>()
  const immediatePolls = new Map<string, string>()
  const baselineReady = new Set<string>()
  const realtimeRuntimes = new Map<string, RealtimeRuntime>()
  const dormantRealtimeSignatures = new Map<string, string>()
  const trackedRuntimePromises = new Set<Promise<void>>()
  const wake = createWakeSignal()
  let policies: ImapDomainPolicy[] = []
  let previousPolicySignature = ""
  let nextConfigCheckAt = 0

  const requestImmediate = (domain: string, trigger: string) => {
    immediatePolls.set(domain, trigger)
    wake.notify()
  }

  const markRealtimeDormant = (domain: string, signature: string) => {
    dormantRealtimeSignatures.set(domain, signature)
  }

  const stopRealtimeRuntime = (domain: string) => {
    const runtime = realtimeRuntimes.get(domain)
    if (!runtime) return
    realtimeRuntimes.delete(domain)
    runtime.controller.abort()
  }

  const syncRealtimeRuntimes = () => {
    const candidates = policies
      .filter(policy => (
        policy.inbound.realtime.enabled
        && baselineReady.has(policy.domain)
        && dormantRealtimeSignatures.get(policy.domain) !== realtimeSignature(policy)
      ))
      .slice(0, MAX_REALTIME_ACCOUNTS)
    const desired = new Map(candidates.map(policy => [policy.domain, policy]))

    for (const [domain, runtime] of realtimeRuntimes) {
      const policy = desired.get(domain)
      if (!policy || runtime.signature !== realtimeSignature(policy)) stopRealtimeRuntime(domain)
    }
    for (const policy of candidates) {
      if (realtimeRuntimes.has(policy.domain)) continue
      const controller = new AbortController()
      const runtime = {
        signature: realtimeSignature(policy),
        controller,
        promise: Promise.resolve(),
      } as RealtimeRuntime
      runtime.promise = runRealtimeSupervisor(
        policy,
        controller.signal,
        requestImmediate,
        markRealtimeDormant,
      )
        .catch(error => {
          console.error(JSON.stringify({
            event: "imap.realtime.supervisor_terminated",
            domain: policy.domain,
            message: safeError(error, [policy.inbound.password, policy.inbound.username]),
          }))
        })
        .finally(() => {
          trackedRuntimePromises.delete(runtime.promise)
          if (realtimeRuntimes.get(policy.domain) === runtime) {
            realtimeRuntimes.delete(policy.domain)
          }
          wake.notify()
        })
      realtimeRuntimes.set(policy.domain, runtime)
      trackedRuntimePromises.add(runtime.promise)
    }
  }

  try {
    while (!signal.aborted) {
      if (!isSetupCompleted()) {
        for (const domain of [...realtimeRuntimes.keys()]) stopRealtimeRuntime(domain)
        policies = []
        previousPolicySignature = ""
        nextPollAt.clear()
        immediatePolls.clear()
        baselineReady.clear()
        dormantRealtimeSignatures.clear()
        await wake.wait(CONFIG_CHECK_MS, signal)
        continue
      }

      const now = Date.now()
      if (now >= nextConfigCheckAt) {
        try {
          const loaded = (await getDomainPolicies())
            .filter((policy): policy is ImapDomainPolicy => policy.inbound.mode === "imap")
          const policySignature = JSON.stringify(loaded.map(policy => ({
            domain: policy.domain,
            inbound: policy.inbound,
          })))
          policies = loaded
          if (policySignature !== previousPolicySignature) {
            previousPolicySignature = policySignature
            const activeDomains = new Set(policies.map(policy => policy.domain))
            const activePolicyByDomain = new Map(policies.map(policy => [policy.domain, policy]))
            for (const [domain, signature] of dormantRealtimeSignatures) {
              const policy = activePolicyByDomain.get(domain)
              if (!policy || realtimeSignature(policy) !== signature) {
                dormantRealtimeSignatures.delete(domain)
              }
            }
            if (activeDomains.size > 0 || await getConfigValue(CONFIG_KEYS.IMAP_SYNC_STATE)) {
              await pruneAccountStates(activeDomains)
            }
            for (const domain of [...realtimeRuntimes.keys()]) stopRealtimeRuntime(domain)
            nextPollAt.clear()
            immediatePolls.clear()
            baselineReady.clear()
            const requestedRealtime = policies.filter(policy => policy.inbound.realtime.enabled).length
            if (requestedRealtime > MAX_REALTIME_ACCOUNTS) {
              console.warn(JSON.stringify({
                event: "imap.realtime.capacity_fallback",
                requested: requestedRealtime,
                active: MAX_REALTIME_ACCOUNTS,
              }))
            }
          }
        } catch (error) {
          console.error(JSON.stringify({
            event: "imap.poller.failed",
            message: safeError(error),
          }))
        }
        nextConfigCheckAt = Date.now() + CONFIG_CHECK_MS
      }

      const policyByDomain = new Map(policies.map(policy => [policy.domain, policy]))
      for (const domain of [...immediatePolls.keys()]) {
        if (!policyByDomain.has(domain)) immediatePolls.delete(domain)
      }
      const due = policies.filter(policy => (
        immediatePolls.has(policy.domain)
        || Date.now() >= (nextPollAt.get(policy.domain) ?? 0)
      ))
      for (let offset = 0; offset < due.length; offset += MAX_CONCURRENT_ACCOUNTS) {
        const batch = due.slice(offset, offset + MAX_CONCURRENT_ACCOUNTS)
        await Promise.all(batch.map(async policy => {
          const trigger = immediatePolls.get(policy.domain) ?? "fallback"
          immediatePolls.delete(policy.domain)
          try {
            const result = await pollImapDomain(policy)
            baselineReady.add(policy.domain)
            if (result.processed > 0) {
              console.log(JSON.stringify({
                event: "imap.poll.completed",
                domain: policy.domain,
                trigger,
                processed: result.processed,
              }))
            }
            if (result.hasMore) requestImmediate(policy.domain, "backlog")
          } catch (error) {
            logPollFailure(error, policy, trigger)
          } finally {
            const fallbackDelay = policy.inbound.pollIntervalSeconds * 1_000
            const bootstrapRetry = policy.inbound.realtime.reconnectMinSeconds * 1_000
            nextPollAt.set(
              policy.domain,
              Date.now() + (baselineReady.has(policy.domain)
                ? fallbackDelay
                : Math.min(fallbackDelay, bootstrapRetry)),
            )
          }
        }))
      }
      syncRealtimeRuntimes()

      let wakeAt = nextConfigCheckAt
      for (const policy of policies) {
        wakeAt = Math.min(wakeAt, nextPollAt.get(policy.domain) ?? Date.now())
      }
      if (immediatePolls.size > 0) wakeAt = Date.now()
      await wake.wait(Math.max(0, wakeAt - Date.now()), signal)
    }
  } finally {
    for (const runtime of realtimeRuntimes.values()) runtime.controller.abort()
    realtimeRuntimes.clear()
    await Promise.allSettled([...trackedRuntimePromises])
  }
}

const globalPoller = globalThis as typeof globalThis & {
  __moemailImapPoller?: PollerRuntime
}

export function startImapPoller() {
  if (globalPoller.__moemailImapPoller) return
  const controller = new AbortController()
  const runtime: PollerRuntime = { controller, promise: runPoller(controller.signal) }
  globalPoller.__moemailImapPoller = runtime
  const clearRuntime = () => {
    if (globalPoller.__moemailImapPoller === runtime) delete globalPoller.__moemailImapPoller
  }
  void runtime.promise.then(clearRuntime, error => {
    clearRuntime()
    console.error(JSON.stringify({
      event: "imap.poller.terminated",
      message: safeError(error),
    }))
  })
}

export async function stopImapPoller() {
  const runtime = globalPoller.__moemailImapPoller
  if (!runtime) return
  runtime.controller.abort()
  await runtime.promise
  if (globalPoller.__moemailImapPoller === runtime) delete globalPoller.__moemailImapPoller
}
