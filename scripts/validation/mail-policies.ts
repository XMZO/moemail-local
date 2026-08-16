import assert from "node:assert/strict"
import { createServer } from "node:net"
import {
  createDefaultAccessPolicies,
  EMPEROR_ACCESS_POLICY,
  isMigratedMailQuotaAssignment,
  isDomainAllowed,
  parseAccessPolicies,
  resolveAccessPolicy,
  resolveMailQuotaAssignment,
  resolveMailQuotaAssignments,
  type MailQuotaPolicy,
  type MailQuotaRule,
} from "../../app/lib/access-policies"
import {
  domainPoliciesSchema,
  publicDomainPolicy,
  type DomainPolicy,
} from "../../app/lib/domain-policies"
import { outboundContent, outboundMessageSchema, sendOutboundMessage, testSmtpConnection } from "../../app/lib/outbound-mail"
import { PERMISSIONS } from "../../app/lib/permissions"
import { sendQuotaWindowMilliseconds } from "../../app/lib/send-permissions"

const domainPolicies = domainPoliciesSchema.parse([
  {
    domain: "Resend.Example",
    usageWarning: true,
    inbound: { mode: "worker" },
    outbound: { mode: "resend", apiKey: "re_test_domain_one", fromName: "Domain One" },
  },
  {
    domain: "smtp.example",
    inbound: {
      mode: "imap",
      host: "imap.example",
      port: 993,
      security: "tls",
      username: "imap-domain-user",
      password: "imap-domain-password",
      rejectUnauthorized: true,
      mailbox: "INBOX",
      recipientHeader: "auto",
      initialSync: "new",
      pollIntervalSeconds: 60,
      maxMessagesPerPoll: 100,
    },
    outbound: {
      mode: "smtp",
      host: "127.0.0.1",
      port: 2525,
      security: "plain",
      authMethod: "plain",
      username: "smtp-domain-user",
      password: "smtp-domain-password",
      rejectUnauthorized: true,
      fromName: null,
    },
  },
])
assert.equal(domainPolicies[0].domain, "resend.example")
assert.equal(domainPolicies[0].usageWarning, true)
assert.equal(domainPolicies[1].usageWarning, false)
assert.deepEqual(publicDomainPolicy(domainPolicies[0]), {
  domain: "resend.example",
  usageWarning: true,
  inboundMode: "worker",
  outboundMode: "resend",
})
const legacyImapInbound = domainPolicies[1].inbound as Extract<DomainPolicy["inbound"], { mode: "imap" }>
assert.equal(legacyImapInbound.connectionTimeoutSeconds, 15)
assert.equal(legacyImapInbound.realtime.enabled, false)
assert.equal(legacyImapInbound.realtime.idleRenewSeconds, 1_500)
assert.throws(() => domainPoliciesSchema.parse([{
  domain: "invalid-reconnect.example",
  inbound: {
    ...legacyImapInbound,
    realtime: {
      ...legacyImapInbound.realtime,
      enabled: true,
      reconnectMinSeconds: 30,
      reconnectMaxSeconds: 5,
    },
  },
  outbound: { mode: "disabled" },
}]), /IMAP_RECONNECT_RANGE_INVALID/u)
assert.throws(() => domainPoliciesSchema.parse([
  { domain: "same.example", inbound: { mode: "worker" }, outbound: { mode: "disabled" } },
  { domain: "SAME.example", inbound: { mode: "worker" }, outbound: { mode: "disabled" } },
]))
assert.throws(() => domainPoliciesSchema.parse([
  { domain: "off.example", inbound: { mode: "disabled" }, outbound: { mode: "disabled" } },
]))
assert.throws(() => domainPoliciesSchema.parse([
  {
    domain: "smtp.example",
    inbound: { mode: "worker" },
    outbound: {
      mode: "smtp",
      host: "smtp.example",
      port: 587,
      security: "starttls",
      authMethod: "auto",
      username: "user",
      password: null,
      rejectUnauthorized: true,
      fromName: null,
    },
  },
]))

const legacySmtpPolicy = domainPoliciesSchema.parse([{
  domain: "legacy-smtp.example",
  inbound: { mode: "worker" },
  outbound: {
    mode: "smtp",
    host: "smtp.example",
    port: 587,
    security: "starttls",
    username: "legacy-user",
    password: "legacy-password",
    rejectUnauthorized: true,
    fromName: null,
  },
}])
assert.equal(legacySmtpPolicy[0].outbound.mode, "smtp")
assert.equal(
  (legacySmtpPolicy[0].outbound as Extract<DomainPolicy["outbound"], { mode: "smtp" }>).authMethod,
  "auto",
)

const accessDefaults = parseAccessPolicies(createDefaultAccessPolicies())
assert.equal(accessDefaults.version, 7)
assert.equal(resolveMailQuotaAssignment(resolveAccessPolicy(accessDefaults, "duke-user", ["duke"]), "send", "box@example.test")?.rolling.limit, 5)
assert.equal(resolveMailQuotaAssignment(resolveAccessPolicy(accessDefaults, "knight-user", ["knight"]), "send", "box@example.test")?.rolling.limit, 2)
assert.equal(resolveMailQuotaAssignment(resolveAccessPolicy(accessDefaults, "civilian-user", ["civilian"]), "send", "box@example.test")?.rolling.limit, 0)
assert.ok(Object.values(PERMISSIONS).every(permission => EMPEROR_ACCESS_POLICY.permissions[permission]))
assert.equal(resolveMailQuotaAssignment(resolveAccessPolicy(accessDefaults, "owner", ["emperor"]), "send", "box@example.test"), undefined)
assert.equal(EMPEROR_ACCESS_POLICY.mailQuotaRules.length, 0)
assert.equal(EMPEROR_ACCESS_POLICY.quotas.maxMessageBytes, 0)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY), true)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY.permissions), true)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY.quotas), true)
assert.equal(EMPEROR_ACCESS_POLICY.allowedDomains, null)

const version5Access = structuredClone(createDefaultAccessPolicies()) as unknown as Record<string, unknown> & {
  version: number
  roles: Record<string, { permissions: Record<string, boolean> }>
  users: Record<string, { permissions: Record<string, boolean>; quotas: Record<string, number> }>
}
version5Access.version = 5
for (const role of Object.values(version5Access.roles)) delete role.permissions.private_recipient_delivery
for (const role of Object.values(version5Access.roles)) delete role.permissions.manage_mailu
version5Access.users.allowedBeforeUpgrade = { permissions: { send_email: true }, quotas: {} }
version5Access.users.deniedBeforeUpgrade = { permissions: { send_email: false }, quotas: {} }
const migratedVersion5 = parseAccessPolicies(version5Access)
assert.equal(migratedVersion5.roles.duke.permissions.private_recipient_delivery, true)
assert.equal(migratedVersion5.roles.civilian.permissions.private_recipient_delivery, false)
assert.equal(migratedVersion5.users.allowedBeforeUpgrade.permissions.private_recipient_delivery, true)
assert.equal(migratedVersion5.users.deniedBeforeUpgrade.permissions.private_recipient_delivery, undefined)

const version6Access = structuredClone(createDefaultAccessPolicies()) as unknown as Record<string, unknown> & {
  version: number
  roles: Record<string, { permissions: Record<string, boolean> }>
  users: Record<string, { permissions: Record<string, boolean> }>
}
version6Access.version = 6
for (const role of Object.values(version6Access.roles)) delete role.permissions.manage_mailu
version6Access.users.explicitOverrides = {
  permissions: { private_recipient_delivery: false },
}
const migratedVersion6 = parseAccessPolicies(version6Access)
assert.equal(migratedVersion6.roles.emperor.permissions.manage_mailu, true)
assert.equal(migratedVersion6.roles.duke.permissions.manage_mailu, false)
assert.equal(migratedVersion6.users.explicitOverrides.permissions.private_recipient_delivery, false)

const legacyDefaults = createDefaultAccessPolicies()
const legacyAccess = {
  version: 1,
  roles: Object.fromEntries((["duke", "knight", "civilian"] as const).map(role => {
    const current = legacyDefaults.roles[role]
    return [role, {
      permissions: Object.fromEntries(Object.entries(current.permissions).filter(
        ([permission]) => permission !== PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY
          && permission !== PERMISSIONS.MANAGE_MAILU,
      )),
      quotas: {
        ...current.quotas,
        dailyReceiveLimit: 0,
        dailySendLimit: role === "duke" ? 5 : role === "knight" ? 2 : 0,
      },
    }]
  })),
  users: {},
}
const migratedLegacyAccess = parseAccessPolicies(legacyAccess)
assert.equal(migratedLegacyAccess.roles.duke.domainAccess.default, "allow")
assert.equal(migratedLegacyAccess.version, 7)
assert.equal(migratedLegacyAccess.roles.duke.permissions.private_recipient_delivery, true)
assert.equal(migratedLegacyAccess.roles.civilian.permissions.private_recipient_delivery, false)
assert.equal(resolveMailQuotaAssignment(resolveAccessPolicy(migratedLegacyAccess, "legacy-duke", ["duke"]), "send", "box@example.test")?.rolling.limit, 5)
assert.equal(resolveMailQuotaAssignment(resolveAccessPolicy(migratedLegacyAccess, "legacy-civilian", ["civilian"]), "send", "box@example.test")?.rolling.limit, -1)

const version4Defaults = createDefaultAccessPolicies()
const legacyUnlimited: MailQuotaRule = { limit: -1, windowValue: 1, windowUnit: "day" }
const legacyUnlimitedMailbox = { rolling: legacyUnlimited, lifetimeLimit: -1 }
const version4Quota = (scope: "user" | "role" = "user"): MailQuotaPolicy => ({
  scope,
  total: structuredClone(legacyUnlimited),
  domains: {},
  mailbox: structuredClone(legacyUnlimitedMailbox),
  domainMailboxes: {},
  mailboxes: {},
})
const version4Access = {
  version: 4,
  roles: Object.fromEntries(((["emperor", "duke", "knight", "civilian"] as const)).map(role => {
    const current = structuredClone(version4Defaults.roles[role])
    delete (current.permissions as Partial<Record<string, boolean>>)[PERMISSIONS.PRIVATE_RECIPIENT_DELIVERY]
    delete (current.permissions as Partial<Record<string, boolean>>)[PERMISSIONS.MANAGE_MAILU]
    return [role, {
      ...current,
      sendQuota: version4Quota(role === "duke" ? "role" : "user"),
      receiveQuota: version4Quota(),
    }]
  })),
  users: {},
}
version4Access.roles.duke.sendQuota.mailbox = {
  rolling: { limit: 9, windowValue: 2, windowUnit: "hour" },
  lifetimeLimit: 4,
}
version4Access.roles.duke.sendQuota.domainMailboxes = {
  "legacy.example": {
    rolling: { limit: 8, windowValue: 1, windowUnit: "day" },
    lifetimeLimit: 3,
  },
}
version4Access.roles.duke.sendQuota.mailboxes = {
  "exact@legacy.example": {
    rolling: { limit: 7, windowValue: 1, windowUnit: "week" },
    lifetimeLimit: 6,
  },
}
const migratedVersion4 = parseAccessPolicies(version4Access)
assert.equal(migratedVersion4.roles.duke.permissions.private_recipient_delivery, true)
assert.equal(migratedVersion4.roles.civilian.permissions.private_recipient_delivery, false)
const migratedDukeRules = migratedVersion4.mailQuotaRules.filter(rule => (
  rule.direction === "send" && rule.subject.type === "role" && rule.subject.role === "duke"
))
const migratedWildcard = migratedDukeRules.find(rule => rule.target.type === "all")!
const migratedDomain = migratedDukeRules.find(rule => rule.target.type === "domain")!
const migratedExact = migratedDukeRules.find(rule => rule.target.type === "mailbox")!
assert.equal(migratedWildcard.rolling.limit, 9)
assert.equal(migratedWildcard.lifetimeLimit, -1)
assert.equal(migratedWildcard.shareWithinRole, true)
assert.equal(migratedDomain.rolling.limit, 8)
assert.equal(migratedDomain.lifetimeLimit, -1)
assert.equal(migratedExact.rolling.limit, 7)
assert.equal(migratedExact.lifetimeLimit, 6)
assert.equal(isMigratedMailQuotaAssignment(migratedWildcard), true)
assert.equal(isMigratedMailQuotaAssignment({ ...migratedWildcard, target: { type: "domain", domain: "forged.example" } }), false)

const restrictedAccess = createDefaultAccessPolicies()
restrictedAccess.roles.duke.domainAccess = { default: "deny", domains: { "alpha.example": "allow" } }
restrictedAccess.roles.knight.domainAccess = { default: "deny", domains: { "beta.example": "allow" } }
restrictedAccess.users.restricted = {
  permissions: {},
  quotas: {},
  domainAccess: { default: "deny", domains: { "user.example": "allow" } },
}
restrictedAccess.mailQuotaRules = [{ id: "11111111-1111-4111-8111-111111111111", direction: "send", subject: { type: "role", role: "duke" }, target: { type: "all" }, rolling: { limit: 10, windowValue: 2, windowUnit: "hour" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }, { id: "22222222-2222-4222-8222-222222222222", direction: "send", subject: { type: "role", role: "duke" }, target: { type: "domain", domain: "alpha.example" }, rolling: { limit: 7, windowValue: 30, windowUnit: "minute" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }, { id: "33333333-3333-4333-8333-333333333333", direction: "send", subject: { type: "role", role: "duke" }, target: { type: "domain", domain: "beta.example" }, rolling: { limit: 6, windowValue: 15, windowUnit: "minute" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }]
assert.deepEqual(
  resolveAccessPolicy(restrictedAccess, "role-only", ["duke", "knight"]).allowedDomains,
  ["alpha.example", "beta.example"],
)
const userRestrictedAccess = resolveAccessPolicy(restrictedAccess, "restricted", ["duke"])
assert.equal(isDomainAllowed(userRestrictedAccess, "USER.EXAMPLE"), true)
assert.equal(isDomainAllowed(userRestrictedAccess, "alpha.example"), false)
assert.equal(resolveAccessPolicy(restrictedAccess, "emperor", ["emperor"]).allowedDomains, null)
assert.equal(resolveAccessPolicy(restrictedAccess, "role-quota", ["duke"]).quotaRole, "duke")
restrictedAccess.users["custom-quota"] = { permissions: {}, quotas: {} }
restrictedAccess.mailQuotaRules.push({ id: "44444444-4444-4444-8444-444444444444", direction: "send", subject: { type: "user", userId: "custom-quota" }, target: { type: "all" }, rolling: { limit: 3, windowValue: 90, windowUnit: "second" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false }, { id: "55555555-5555-4555-8555-555555555555", direction: "send", subject: { type: "user", userId: "custom-quota" }, target: { type: "domain", domain: "alpha.example" }, rolling: { limit: 0, windowValue: 1, windowUnit: "day" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false })
const customQuota = resolveAccessPolicy(restrictedAccess, "custom-quota", ["duke"])
assert.equal(resolveMailQuotaAssignment(customQuota, "send", "box@alpha.example")?.rolling.limit, 0)
assert.equal(resolveMailQuotaAssignment(customQuota, "send", "box@beta.example")?.rolling.limit, 3)
assert.equal(resolveMailQuotaAssignment(customQuota, "send", "box@other.example")?.rolling.limit, 3)
assert.equal(sendQuotaWindowMilliseconds({ limit: 1, windowValue: 90, windowUnit: "second" }), 90_000)
assert.equal(sendQuotaWindowMilliseconds({ limit: 1, windowValue: 2, windowUnit: "month" }), 60 * 24 * 60 * 60 * 1_000)
const emperorOverride = structuredClone(restrictedAccess)
emperorOverride.users.owner = { permissions: {}, quotas: {} }
emperorOverride.mailQuotaRules.push({ id: "66666666-6666-4666-8666-666666666666", direction: "send", subject: { type: "user", userId: "owner" }, target: { type: "all" }, rolling: { limit: 1, windowValue: 1, windowUnit: "minute" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false })
const emperorQuota = resolveAccessPolicy(emperorOverride, "owner", ["emperor"])
assert.ok(Object.values(emperorQuota.permissions).every(Boolean))
assert.equal(emperorQuota.allowedDomains, null)
assert.equal(resolveMailQuotaAssignment(emperorQuota, "send", "owner@example.test")?.rolling.limit, 1)
const globalEmperorPolicy = createDefaultAccessPolicies()
globalEmperorPolicy.mailQuotaRules.push({ id: "77777777-7777-4777-8777-777777777777", direction: "send", subject: { type: "all" }, target: { type: "all" }, rolling: { limit: 100, windowValue: 1, windowUnit: "day" }, lifetimeLimit: -1, shareWithinRole: false, ignoreEmperor: false })
assert.equal(resolveMailQuotaAssignments(resolveAccessPolicy(globalEmperorPolicy, "owner", ["emperor"]), "send", "owner@example.test")[0]?.rolling.limit, 100)
globalEmperorPolicy.mailQuotaRules[globalEmperorPolicy.mailQuotaRules.length - 1].ignoreEmperor = true
assert.equal(resolveMailQuotaAssignments(resolveAccessPolicy(globalEmperorPolicy, "owner", ["emperor"]), "send", "owner@example.test").length, 0)
const invalidGlobalRule = globalEmperorPolicy.mailQuotaRules.at(-1)!
assert.throws(() => parseAccessPolicies({
  ...globalEmperorPolicy,
  mailQuotaRules: [{ ...invalidGlobalRule, shareWithinRole: true }],
}))
assert.throws(() => parseAccessPolicies({
  ...globalEmperorPolicy,
  mailQuotaRules: [{ ...invalidGlobalRule, lifetimeLimit: 1 }],
}))
assert.throws(() => parseAccessPolicies({
  ...restrictedAccess,
  roles: {
    ...restrictedAccess.roles,
    duke: { ...restrictedAccess.roles.duke, domainAccess: { default: "deny", domains: { "SAME.example": "allow" } } },
  },
}))

const originalFetch = globalThis.fetch
let resendRequest: Request | null = null
globalThis.fetch = async (input, init) => {
  resendRequest = new Request(input, init)
  return Response.json({ id: "mail_test" }, { status: 200 })
}
try {
  await sendOutboundMessage(
    "sender@resend.example",
    { to: "recipient@example.net; SECOND@example.net", subject: "Policy test", content: "<b>hello</b>", format: "html" },
    domainPolicies[0],
  )
} finally {
  globalThis.fetch = originalFetch
}
assert.ok(resendRequest)
const capturedResendRequest = resendRequest as unknown as Request
assert.equal(capturedResendRequest.headers.get("authorization"), "Bearer re_test_domain_one")
assert.equal(capturedResendRequest.redirect, "manual")
const resendBody = await capturedResendRequest.json() as { from: string; to: string[]; html: string; text?: string }
assert.equal(resendBody.from, "Domain One <sender@resend.example>")
assert.deepEqual(resendBody.to, ["recipient@example.net", "second@example.net"])
assert.match(resendBody.html, /^<!doctype html><html>/i)
assert.equal(resendBody.text, "hello")

const privateResendRequests: Request[] = []
globalThis.fetch = async (input, init) => {
  privateResendRequests.push(new Request(input, init))
  return Response.json({ data: [{ id: "mail_private_one" }, { id: "mail_private_two" }] }, { status: 200 })
}
try {
  await sendOutboundMessage(
    "sender@resend.example",
    {
      to: "private-one@example.net; private-two@example.net",
      subject: "Private Resend",
      content: "hello",
      format: "text",
      privateRecipients: true,
    },
    domainPolicies[0],
  )
} finally {
  globalThis.fetch = originalFetch
}
assert.equal(privateResendRequests.length, 1)
assert.equal(new URL(privateResendRequests[0].url).pathname, "/emails/batch")
const privateResendBody = await privateResendRequests[0].json() as Array<{ to: string[] }>
assert.deepEqual(privateResendBody.map(delivery => delivery.to), [
  ["private-one@example.net"],
  ["private-two@example.net"],
])
assert.equal(
  outboundMessageSchema.parse({
    to: "recipient@example.net",
    subject: "Legacy API",
    content: "<p>preserved</p>",
  }).format,
  "html",
)
assert.deepEqual(
  outboundMessageSchema.parse({
    to: "First@Example.net; second@example.net, first@example.net",
    subject: "Multiple recipients",
    content: "hello",
    format: "text",
  }).to,
  ["first@example.net", "second@example.net"],
)
assert.equal(outboundMessageSchema.parse({
  to: "recipient@example.net",
  subject: "Default visibility",
  content: "hello",
  format: "text",
}).privateRecipients, false)
assert.deepEqual(outboundMessageSchema.parse({
  to: "recipient@example.net, ",
  subject: "Trailing separator",
  content: "hello",
  format: "text",
}).to, ["recipient@example.net"])
assert.deepEqual(outboundMessageSchema.parse({
  to: "first@example.net， second@example.net；FIRST@example.net",
  subject: "Localized separators",
  content: "hello",
  format: "text",
}).to, ["first@example.net", "second@example.net"])
assert.deepEqual(
  outboundContent({ to: ["recipient@example.net"], subject: "Text", content: "<unsafe>&", format: "text", privateRecipients: false }),
  {
    text: "<unsafe>&",
    html: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><pre style=\"white-space:pre-wrap;font:inherit\">&lt;unsafe&gt;&amp;</pre></body></html>",
  },
)
assert.deepEqual(
  outboundContent({
    to: ["recipient@example.net"],
    subject: "Image fallback",
    content: '<head><style>hidden</style></head><p>Hello&nbsp;<strong>world</strong></p><img src="pixel" alt="chart &amp; summary"><script>alert(1)</script>',
    format: "html",
    privateRecipients: false,
  }),
  {
    text: "Hello world\nchart & summary",
    html: '<!doctype html><html><head><meta charset="utf-8"></head><body><head><style>hidden</style></head><p>Hello&nbsp;<strong>world</strong></p><img src="pixel" alt="chart &amp; summary"><script>alert(1)</script></body></html>',
  },
)
assert.equal(
  outboundContent({
    to: ["recipient@example.net"],
    subject: "Image-only message",
    content: '<img src="pixel">',
    format: "html",
    privateRecipients: false,
  }).text,
  "Image-only message",
)
const adversarialHtml = "<script>".repeat(250_000)
const conversionStarted = performance.now()
assert.equal(
  outboundContent({
    to: ["recipient@example.net"],
    subject: "Adversarial fallback",
    content: adversarialHtml,
    format: "html",
    privateRecipients: false,
  }).text,
  "Adversarial fallback",
)
assert(
  performance.now() - conversionStarted < 2_000,
  "HTML text fallback must remain bounded for adversarial unclosed tags",
)

let smtpRaw = ""
let smtpAuthenticated = false
const smtpServer = createServer(socket => {
  socket.setEncoding("utf8")
  socket.write("220 mock.example ESMTP\r\n")
  let input = ""
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
          socket.write("250 queued\r\n")
        } else {
          smtpRaw += `${line}\r\n`
        }
        continue
      }
      if (/^EHLO /i.test(line)) socket.write("250-mock.example\r\n250 AUTH PLAIN LOGIN\r\n")
      else if (/^AUTH PLAIN /i.test(line)) {
        const payload = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8")
        assert.equal(payload, "\0smtp-domain-user\0smtp-domain-password")
        smtpAuthenticated = true
        socket.write("235 authenticated\r\n")
      } else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write("250 ok\r\n")
      else if (/^DATA$/i.test(line)) {
        dataMode = true
        socket.write("354 end with dot\r\n")
      } else if (/^QUIT$/i.test(line)) {
        socket.end("221 bye\r\n")
      } else socket.write("250 ok\r\n")
    }
  })
})
await new Promise<void>((resolve, reject) => {
  smtpServer.once("error", reject)
  smtpServer.listen(0, "127.0.0.1", resolve)
})
const address = smtpServer.address()
assert.ok(address && typeof address === "object")
const smtpPolicy: DomainPolicy = {
  ...domainPolicies[1],
  outbound: { ...domainPolicies[1].outbound as Extract<DomainPolicy["outbound"], { mode: "smtp" }>, port: address.port },
}
try {
  const connection = await testSmtpConnection(
    smtpPolicy.outbound as Extract<DomainPolicy["outbound"], { mode: "smtp" }>,
  )
  assert.equal(connection.ok, true)
  await sendOutboundMessage(
    "sender@smtp.example",
    { to: "recipient@example.net, second@example.net", subject: "SMTP policy test", content: "<p>smtp hello</p>", format: "html" },
    smtpPolicy,
  )
} finally {
  await new Promise<void>(resolve => smtpServer.close(() => resolve()))
}
assert.match(smtpRaw, /Subject: SMTP policy test/)
assert.match(smtpRaw, /recipient@example\.net/)
assert.match(smtpRaw, /second@example\.net/)
assert.match(smtpRaw, /smtp (?:=\r?\n)?hello/)
assert.match(smtpRaw, /<html/i)
assert.match(smtpRaw, /Content-Type: text\/plain/i)
assert.match(smtpRaw, /smtp hello/i)
assert.equal(smtpAuthenticated, true)

const privateSmtpMessages: string[] = []
{
  const privateSmtpServer = createServer(socket => {
    socket.setEncoding("utf8")
    socket.write("220 private.example ESMTP\r\n")
    let input = ""
    let data = ""
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
            privateSmtpMessages.push(data)
            data = ""
            socket.write("250 queued\r\n")
          } else data += `${line}\r\n`
        } else if (/^EHLO /iu.test(line)) socket.write("250 private.example\r\n")
        else if (/^DATA$/iu.test(line)) { dataMode = true; socket.write("354 end\r\n") }
        else if (/^QUIT$/iu.test(line)) socket.end("221 bye\r\n")
        else socket.write("250 ok\r\n")
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    privateSmtpServer.once("error", reject)
    privateSmtpServer.listen(0, "127.0.0.1", resolve)
  })
  const privateAddress = privateSmtpServer.address()
  assert.ok(privateAddress && typeof privateAddress === "object")
  const privatePolicy: DomainPolicy = {
    ...domainPolicies[1],
    outbound: {
      ...(domainPolicies[1].outbound as Extract<DomainPolicy["outbound"], { mode: "smtp" }>),
      port: privateAddress.port,
      username: null,
      password: null,
    },
  }
  try {
    await sendOutboundMessage("sender@smtp.example", {
      to: "private-one@example.net, private-two@example.net",
      subject: "Private delivery",
      content: "private",
      format: "text",
      privateRecipients: true,
    }, privatePolicy)
  } finally {
    await new Promise<void>(resolve => privateSmtpServer.close(() => resolve()))
  }
  assert.equal(privateSmtpMessages.length, 2)
  const privateOne = privateSmtpMessages.find(message => /To: private-one@example\.net/iu.test(message))
  const privateTwo = privateSmtpMessages.find(message => /To: private-two@example\.net/iu.test(message))
  assert.ok(privateOne)
  assert.ok(privateTwo)
  assert.doesNotMatch(privateOne, /private-two@example\.net/iu)
  assert.doesNotMatch(privateTwo, /private-one@example\.net/iu)
}

let smtpLoginAuthenticated = false
let smtpLoginStep: "idle" | "username" | "password" = "idle"
const smtpLoginServer = createServer(socket => {
  socket.setEncoding("utf8")
  socket.write("220 login.example ESMTP\r\n")
  let input = ""
  socket.on("data", chunk => {
    input += chunk
    while (true) {
      const end = input.indexOf("\r\n")
      if (end < 0) break
      const line = input.slice(0, end)
      input = input.slice(end + 2)
      if (smtpLoginStep === "username") {
        assert.equal(Buffer.from(line, "base64").toString("utf8"), "microsoft-user@example.com")
        smtpLoginStep = "password"
        socket.write("334 UGFzc3dvcmQ6\r\n")
      } else if (smtpLoginStep === "password") {
        assert.equal(Buffer.from(line, "base64").toString("utf8"), "microsoft-app-password")
        smtpLoginAuthenticated = true
        smtpLoginStep = "idle"
        socket.write("235 authenticated\r\n")
      } else if (/^EHLO /i.test(line)) socket.write("250-login.example\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n")
      else if (/^AUTH LOGIN$/i.test(line)) {
        smtpLoginStep = "username"
        socket.write("334 VXNlcm5hbWU6\r\n")
      } else if (/^QUIT$/i.test(line)) socket.end("221 bye\r\n")
      else socket.write("250 ok\r\n")
    }
  })
})
await new Promise<void>((resolve, reject) => {
  smtpLoginServer.once("error", reject)
  smtpLoginServer.listen(0, "127.0.0.1", resolve)
})
const loginAddress = smtpLoginServer.address()
assert.ok(loginAddress && typeof loginAddress === "object")
try {
  const result = await testSmtpConnection({
    mode: "smtp",
    host: "127.0.0.1",
    port: loginAddress.port,
    security: "plain",
    authMethod: "login",
    username: "microsoft-user@example.com",
    password: "microsoft-app-password",
    rejectUnauthorized: true,
    fromName: null,
  })
  assert.equal(result.ok, true)
} finally {
  await new Promise<void>(resolve => smtpLoginServer.close(() => resolve()))
}
assert.equal(smtpLoginAuthenticated, true)

console.log(JSON.stringify({
  domainPolicyValidation: true,
  independentResendKey: true,
  independentSmtpCredentials: true,
  privateRecipientResendBatchVerified: true,
  privateRecipientSmtpDeliveryVerified: true,
  smtpConnectionAndAuthenticationVerified: true,
  smtpLegacyConfigDefaultsToAuto: true,
  smtpForcedLoginVerified: true,
  htmlDocumentAndTextAlternativeVerified: true,
  emperorPolicyImmutableInCode: true,
  roleAndUserDomainRestrictionsVerified: true,
  legacyAccessPolicyMigratesToAllDomains: true,
}))
