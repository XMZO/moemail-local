import { and, eq, gt, sql } from "drizzle-orm"
import { createDb } from "../db"
import { isSetupCompleted } from "../config/runtime"
import { getDomainPolicies } from "../domain-policies"
import { normalizeMailboxAddress } from "../email-address"
import {
  getAccessPolicies,
  isDomainOperationAllowed,
  resolveAccessPolicy,
} from "../access-policies"
import { PERMISSIONS, ROLES, type Role } from "../permissions"
import { emails, roles, userRoles } from "../schema"
import { getUserAccessPolicy } from "../user-access"
import { MailuApiError, MailuClient, type MailuAlias, type MailuUser } from "./client"
import { getMailuIntegration, type MailuIntegration } from "./config"

const commentPrefix = "MoeMail Local managed:"

const globalMutationState = globalThis as typeof globalThis & {
  __moemailMailuMutationTail?: Promise<void>
}

/**
 * Serializes Mailu mutations with configuration commits in this Web process.
 * The supported deployment runs one Web instance; PostgreSQL-backed IMAP
 * polling has its own cross-process lease, while remote API reconciliation and
 * credential rotation must not interleave inside that instance.
 */
export async function withMailuMutation<T>(task: () => Promise<T>) {
  const predecessor = globalMutationState.__moemailMailuMutationTail ?? Promise.resolve()
  let release = () => {}
  globalMutationState.__moemailMailuMutationTail = new Promise<void>(resolve => { release = resolve })
  await predecessor.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
  }
}

function managedComment(integration: MailuIntegration, kind: "mailbox" | "catch-all") {
  return `${commentPrefix}${integration.integrationId}:${kind}`
}

function ownedByIntegration(alias: MailuAlias, integration: MailuIntegration) {
  return alias.comment === managedComment(integration, "mailbox")
    || alias.comment === managedComment(integration, "catch-all")
}

export function isMailuManagedAlias(alias: MailuAlias, integration: MailuIntegration) {
  return ownedByIntegration(alias, integration)
}

export function expectedMailboxAlias(
  integration: MailuIntegration,
  address: string,
  destination: "collector" | "catch-all" = "collector",
) {
  return {
    destination: [destination === "collector" ? integration.collector.address : integration.catchAll.address],
    wildcard: false,
    comment: managedComment(integration, "mailbox"),
  }
}

export function assertMailuSenderAlias(alias: MailuAlias, integration: MailuIntegration, address: string) {
  const expected = expectedMailboxAlias(integration, address)
  if (
    alias.email.toLowerCase() !== address
    || !ownedByIntegration(alias, integration)
    || alias.comment !== expected.comment
    || alias.wildcard
    || alias.disabled
    || alias.destination.length !== 1
    || normalizeMailboxAddress(alias.destination[0]) !== integration.collector.address
  ) throw new Error("MAILU_SENDER_ALIAS_UNSAFE")
}

function normalizedSet(values: string[]) {
  return new Set(values.map(normalizeMailboxAddress).filter((value): value is string => Boolean(value)))
}

async function ensureServiceUser(
  client: MailuClient,
  users: Map<string, MailuUser>,
  input: { address: string; password: string },
  purpose: "collector" | "catch-all",
  integration: MailuIntegration,
  rotateCredentials: boolean,
) {
  const existing = users.get(input.address)
  const patch = purpose === "collector"
    ? { enabled: true, enable_imap: true, enable_pop: false, allow_spoofing: false, forward_enabled: false }
    : {
        // Mailu's sender-login lookup resolves a wildcard alias to its
        // destination user. Keeping this forwarding-only account disabled
        // preserves alias resolution while making its password unusable for
        // SMTP/IMAP authentication, so a leaked secret cannot send as an
        // arbitrary address in a catch-all domain.
        enabled: false,
        enable_imap: false,
        enable_pop: false,
        allow_spoofing: false,
        forward_enabled: true,
        forward_destination: [integration.collector.address],
        forward_keep: false,
      }
  const comment = `${commentPrefix}${integration.integrationId}:service:${purpose}`
  if (!existing) {
    await client.createUser({
      email: input.address,
      raw_password: input.password,
      comment,
      ...patch,
    })
    return
  }
  if (existing.comment !== comment) throw new Error(`MAILU_SERVICE_USER_OWNERSHIP_CONFLICT:${purpose}`)
  // This is our marked service user, so security drift is repaired rather
  // than merely reported. The patch always writes allow_spoofing=false and
  // also restores the intended login/forwarding state.
  await client.updateUser(input.address, {
    ...patch,
    ...(rotateCredentials ? { raw_password: input.password } : {}),
  })
}

export async function rotateMailuServiceCredentials(
  integration: MailuIntegration,
  rotate: "collector" | "catchAll" | "all",
) {
  if (!integration.enabled) throw new Error("MAILU_INTEGRATION_DISABLED")
  const client = new MailuClient(integration)
  const users = new Map((await client.listUsers()).map(user => [user.email.toLowerCase(), user]))
  if (rotate === "collector" || rotate === "all") {
    await ensureServiceUser(client, users, integration.collector, "collector", integration, true)
  }
  if (rotate === "catchAll" || rotate === "all") {
    await ensureServiceUser(client, users, integration.catchAll, "catch-all", integration, true)
  }
  return { ok: true as const }
}

async function reconcileMailuUnlocked(integration: MailuIntegration) {
  if (!integration.enabled) throw new Error("MAILU_INTEGRATION_DISABLED")
  const client = new MailuClient(integration)
  const [domains, usersList, aliases] = await Promise.all([
    client.listDomains(),
    client.listUsers(),
    client.listAliases(),
  ])
  const domainNames = new Set(domains.map(item => item.name.toLowerCase()))
  const users = new Map(usersList.map(user => [user.email.toLowerCase(), user]))
  const collectorDomain = integration.collector.address.split("@")[1]
  const catchAllDomain = integration.catchAll.address.split("@")[1]
  if (!domainNames.has(collectorDomain) || !domainNames.has(catchAllDomain)) {
    throw new Error("MAILU_SERVICE_ACCOUNT_DOMAIN_MISSING")
  }
  await ensureServiceUser(client, users, integration.collector, "collector", integration, false)
  await ensureServiceUser(client, users, integration.catchAll, "catch-all", integration, false)

  const policies = await getDomainPolicies()
  const inboundDomains = policies
    .filter(policy => policy.inbound.mode === "mailu")
    .map(policy => policy.domain)
  const outboundDomains = policies
    .filter(policy => policy.outbound.mode === "mailu")
    .map(policy => policy.domain)
  const managedDomains = [...new Set([...inboundDomains, ...outboundDomains])]
  const missingDomains = managedDomains.filter(domain => !domainNames.has(domain))
  if (missingDomains.length) throw new Error(`MAILU_DOMAIN_MISSING:${missingDomains.join(",")}`)

  const activeRows = managedDomains.length === 0
    ? []
    : await createDb()
        .select({ address: emails.address, userId: emails.userId, roleName: roles.name })
        .from(emails)
        .leftJoin(userRoles, eq(userRoles.userId, emails.userId))
        .leftJoin(roles, eq(roles.id, userRoles.roleId))
        .where(gt(emails.expiresAt, new Date()))
  const validRoles = new Set<Role>(Object.values(ROLES))
  const activeMailboxes = new Map<string, { address: string; userId: string | null; roles: Set<Role> }>()
  for (const row of activeRows) {
    const address = normalizeMailboxAddress(row.address)
    if (!address || !managedDomains.includes(address.slice(address.lastIndexOf("@") + 1))) continue
    const mailbox = activeMailboxes.get(address) ?? { address, userId: row.userId, roles: new Set<Role>() }
    if (row.roleName && validRoles.has(row.roleName as Role)) mailbox.roles.add(row.roleName as Role)
    activeMailboxes.set(address, mailbox)
  }
  const accessPolicies = await getAccessPolicies()
  const desired = new Map<string, { destination: string[]; wildcard: boolean; comment: string }>()
  const inboundDomainSet = new Set(inboundDomains)
  const outboundDomainSet = new Set(outboundDomains)
  for (const mailbox of activeMailboxes.values()) {
    const { address } = mailbox
    const domain = address.slice(address.lastIndexOf("@") + 1)
    const access = mailbox.userId
      ? resolveAccessPolicy(accessPolicies, mailbox.userId, [...mailbox.roles])
      : null
    const canSend = Boolean(
      access
      && outboundDomainSet.has(domain)
      && access.permissions[PERMISSIONS.SEND_EMAIL]
      && isDomainOperationAllowed(access, domain, "send"),
    )
    if (canSend || inboundDomainSet.has(domain)) {
      desired.set(address, expectedMailboxAlias(
        integration,
        address,
        canSend ? "collector" : "catch-all",
      ))
    }
  }
  if (integration.reconciliation.createCatchAll) {
    for (const domain of inboundDomains) desired.set(`%@${domain}`, {
      destination: [integration.catchAll.address],
      wildcard: true,
      comment: managedComment(integration, "catch-all"),
    })
  }

  const existingByAddress = new Map(aliases.map(alias => [alias.email.toLowerCase(), alias]))
  let created = 0
  let updated = 0
  let removed = 0
  for (const [email, wanted] of desired) {
    const existing = existingByAddress.get(email)
    if (!existing) {
      await client.createAlias({ email, ...wanted })
      created += 1
      continue
    }
    if (!ownedByIntegration(existing, integration)) {
      throw new Error(`MAILU_ALIAS_OWNERSHIP_CONFLICT:${email}`)
    }
    if (existing.disabled) {
      // Mailu's current global v1 alias PATCH schema advertises `disabled`,
      // but its handler does not apply that field (only /alias/me does). Since
      // this object carries our exact ownership marker, recreate it instead of
      // falsely reporting a disabled alias as repaired.
      await client.deleteAlias(email)
      await client.createAlias({ email, ...wanted })
      updated += 1
      continue
    }
    const destinationsEqual = normalizedSet(existing.destination).size === normalizedSet(wanted.destination).size
      && [...normalizedSet(wanted.destination)].every(destination => normalizedSet(existing.destination).has(destination))
    if (!destinationsEqual || existing.wildcard !== wanted.wildcard || existing.comment !== wanted.comment) {
      await client.updateAlias(email, wanted)
      updated += 1
    }
  }

  for (const alias of aliases) {
    const email = alias.email.toLowerCase()
    if (!ownedByIntegration(alias, integration) || desired.has(email)) continue
    // An exact/wildcard alias that still resolves to the SMTP collector is an
    // active sender-login authorization. Revoke it whenever the corresponding
    // MoeMail mailbox/domain/permission is no longer desired, even when the
    // administrator chose to retain harmless stale catch-all aliases.
    const authorizesCollector = normalizedSet(alias.destination).has(integration.collector.address)
    if (integration.reconciliation.removeStaleAliases || authorizesCollector) {
      await client.deleteAlias(email)
      removed += 1
    }
  }
  return { ok: true as const, domains: managedDomains.length, mailboxes: activeMailboxes.size, created, updated, removed }
}

export function reconcileMailu(integration: MailuIntegration) {
  return withMailuMutation(async () => {
    const current = await getMailuIntegration()
    if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(integration)) {
      throw new Error("MAILU_POLICY_CHANGED")
    }
    return reconcileMailuUnlocked(current)
  })
}

/** Queue a reconciliation that reads both integration and policy state only
 * after acquiring the mutation lock. Callers may invoke this after committing
 * a mailbox or permission change without racing an older config snapshot. */
export function reconcileCurrentMailuIfEnabled() {
  return withMailuMutation(async () => {
    const current = await getMailuIntegration()
    if (!current?.enabled || !current.reconciliation.enabled) return null
    return reconcileMailuUnlocked(current)
  })
}

let nextRunAt = 0
let running: Promise<unknown> | null = null

export async function reconcileMailuIfDue(force = false) {
  const integration = await getMailuIntegration()
  if (!integration?.enabled || !integration.reconciliation.enabled) return null
  if (!force && Date.now() < nextRunAt) return null
  if (running) return running
  nextRunAt = Date.now() + integration.reconciliation.intervalSeconds * 1_000
  running = reconcileCurrentMailuIfEnabled().finally(() => { running = null })
  return running
}

export async function ensureMailuSenderAlias(integration: MailuIntegration, rawAddress: string) {
  const address = normalizeMailboxAddress(rawAddress)
  if (!address) throw new Error("MAILU_SENDER_ADDRESS_INVALID")
  const policies = await getDomainPolicies()
  const domain = address.slice(address.lastIndexOf("@") + 1)
  if (!policies.some(policy => policy.domain === domain && policy.outbound.mode === "mailu")) {
    throw new Error("MAILU_SENDER_DOMAIN_DISABLED")
  }
  const active = await createDb().query.emails.findFirst({
    where: and(
      eq(sql`LOWER(${emails.address})`, address),
      gt(emails.expiresAt, new Date()),
    ),
    columns: { id: true, userId: true },
  })
  if (!active?.userId) throw new Error("MAILU_SENDER_MAILBOX_INACTIVE")
  const access = await getUserAccessPolicy(active.userId)
  if (
    !access.permissions[PERMISSIONS.SEND_EMAIL]
    || !isDomainOperationAllowed(access, domain, "send")
  ) throw new Error("MAILU_SENDER_PERMISSION_DENIED")

  const client = new MailuClient(integration)
  try {
    const alias = await client.getAlias(address)
    assertMailuSenderAlias(alias, integration, address)
    return alias
  } catch (error) {
    if (!(error instanceof MailuApiError) || error.status !== 404) throw error
  }
  // Do not reuse an already-running scheduled pass here: it may have captured
  // the mailbox list just before this address was created. Queue one fresh,
  // serialized pass so the first send cannot observe that stale snapshot.
  await reconcileMailu(integration)
  const alias = await client.getAlias(address)
  assertMailuSenderAlias(alias, integration, address)
  return alias
}

export function isMailuConflict(error: unknown) {
  return error instanceof MailuApiError && error.status === 409
}

const globalState = globalThis as typeof globalThis & { __moemailMailuReconciler?: AbortController }

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
    try {
      if (isSetupCompleted()) await reconcileMailuIfDue()
    } catch (error) {
      console.error(JSON.stringify({
        event: "mailu.reconcile.failed",
        message: (error instanceof Error ? error.message : "unknown").replace(/[\r\n\0]+/gu, " ").slice(0, 300),
      }))
    }
    await wait(5_000, signal)
  }
}

export function startMailuReconciler() {
  if (globalState.__moemailMailuReconciler) return
  const controller = new AbortController()
  globalState.__moemailMailuReconciler = controller
  void loop(controller.signal)
}
