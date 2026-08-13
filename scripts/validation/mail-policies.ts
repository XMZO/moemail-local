import assert from "node:assert/strict"
import { createServer } from "node:net"
import {
  createDefaultAccessPolicies,
  EMPEROR_ACCESS_POLICY,
  isDomainAllowed,
  parseAccessPolicies,
  resolveAccessPolicy,
  sendQuotaRuleForDomain,
} from "../../app/lib/access-policies"
import { domainPoliciesSchema, type DomainPolicy } from "../../app/lib/domain-policies"
import { outboundContent, outboundMessageSchema, sendOutboundMessage, testSmtpConnection } from "../../app/lib/outbound-mail"
import { PERMISSIONS } from "../../app/lib/permissions"
import { sendQuotaWindowMilliseconds } from "../../app/lib/send-permissions"

const domainPolicies = domainPoliciesSchema.parse([
  {
    domain: "Resend.Example",
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
assert.equal(accessDefaults.version, 4)
assert.equal(accessDefaults.roles.duke.sendQuota.total.limit, 5)
assert.equal(accessDefaults.roles.knight.sendQuota.total.limit, 2)
assert.equal(accessDefaults.roles.civilian.sendQuota.total.limit, 0)
assert.ok(Object.values(PERMISSIONS).every(permission => EMPEROR_ACCESS_POLICY.permissions[permission]))
assert.equal(accessDefaults.roles.emperor.sendQuota.total.limit, -1)
assert.equal(EMPEROR_ACCESS_POLICY.sendQuota.total.limit, -1)
assert.equal(EMPEROR_ACCESS_POLICY.quotas.maxMessageBytes, 0)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY), true)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY.permissions), true)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY.quotas), true)
assert.equal(EMPEROR_ACCESS_POLICY.allowedDomains, null)

const legacyAccess = {
  version: 1,
  roles: Object.fromEntries((["duke", "knight", "civilian"] as const).map(role => {
    const current = accessDefaults.roles[role]
    return [role, {
      permissions: current.permissions,
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
assert.equal(migratedLegacyAccess.roles.duke.sendQuota.total.limit, 5)
assert.equal(migratedLegacyAccess.roles.civilian.sendQuota.total.limit, -1)

const restrictedAccess = createDefaultAccessPolicies()
restrictedAccess.roles.duke.domainAccess = { default: "deny", domains: { "alpha.example": "allow" } }
restrictedAccess.roles.knight.domainAccess = { default: "deny", domains: { "beta.example": "allow" } }
restrictedAccess.users.restricted = {
  permissions: {},
  quotas: {},
  domainAccess: { default: "deny", domains: { "user.example": "allow" } },
}
restrictedAccess.roles.duke.sendQuota = {
  scope: "role",
  total: { limit: 10, windowValue: 2, windowUnit: "hour" },
  domains: {
    "alpha.example": { limit: 7, windowValue: 30, windowUnit: "minute" },
    "beta.example": { limit: 6, windowValue: 15, windowUnit: "minute" },
  },
  mailbox: { rolling: { limit: -1, windowValue: 1, windowUnit: "day" }, lifetimeLimit: -1 },
  domainMailboxes: {},
  mailboxes: {},
}
assert.deepEqual(
  resolveAccessPolicy(restrictedAccess, "role-only", ["duke", "knight"]).allowedDomains,
  ["alpha.example", "beta.example"],
)
const userRestrictedAccess = resolveAccessPolicy(restrictedAccess, "restricted", ["duke"])
assert.equal(isDomainAllowed(userRestrictedAccess, "USER.EXAMPLE"), true)
assert.equal(isDomainAllowed(userRestrictedAccess, "alpha.example"), false)
assert.equal(resolveAccessPolicy(restrictedAccess, "emperor", ["emperor"]).allowedDomains, null)
assert.equal(resolveAccessPolicy(restrictedAccess, "role-quota", ["duke"]).sendQuota.scope, "role")
assert.equal(resolveAccessPolicy(restrictedAccess, "role-quota", ["duke"]).sendQuotaRole, "duke")
restrictedAccess.users["custom-quota"] = {
  permissions: {},
  quotas: {},
  sendQuota: {
    total: { limit: 3, windowValue: 90, windowUnit: "second" },
    domains: {
      "alpha.example": { limit: 0, windowValue: 1, windowUnit: "day" },
    },
  },
}
const customQuota = resolveAccessPolicy(restrictedAccess, "custom-quota", ["duke"])
assert.equal(customQuota.sendQuota.scope, "user")
assert.equal(customQuota.sendQuota.total.limit, 3)
assert.equal(customQuota.sendQuota.domains["alpha.example"].limit, 0)
assert.equal(customQuota.sendQuota.domains["beta.example"].limit, 6)
assert.equal(sendQuotaRuleForDomain(customQuota, "alpha.example").limit, 0)
assert.equal(sendQuotaRuleForDomain(customQuota, "other.example").limit, -1)
assert.equal(sendQuotaWindowMilliseconds({ limit: 1, windowValue: 90, windowUnit: "second" }), 90_000)
assert.equal(sendQuotaWindowMilliseconds({ limit: 1, windowValue: 2, windowUnit: "month" }), 60 * 24 * 60 * 60 * 1_000)
const emperorOverride = structuredClone(restrictedAccess)
emperorOverride.users.owner = {
  permissions: {},
  quotas: {},
  sendQuota: { total: { limit: 1, windowValue: 1, windowUnit: "minute" } },
}
const emperorQuota = resolveAccessPolicy(emperorOverride, "owner", ["emperor"])
assert.ok(Object.values(emperorQuota.permissions).every(Boolean))
assert.equal(emperorQuota.allowedDomains, null)
assert.equal(emperorQuota.sendQuota.total.limit, 1)
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
    { to: "recipient@example.net", subject: "Policy test", content: "<b>hello</b>", format: "html" },
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
assert.deepEqual(resendBody.to, ["recipient@example.net"])
assert.match(resendBody.html, /^<!doctype html><html>/i)
assert.equal(resendBody.text, "hello")
assert.equal(
  outboundMessageSchema.parse({
    to: "recipient@example.net",
    subject: "Legacy API",
    content: "<p>preserved</p>",
  }).format,
  "html",
)
assert.deepEqual(
  outboundContent({ to: "recipient@example.net", subject: "Text", content: "<unsafe>&", format: "text" }),
  {
    text: "<unsafe>&",
    html: "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><pre style=\"white-space:pre-wrap;font:inherit\">&lt;unsafe&gt;&amp;</pre></body></html>",
  },
)
assert.deepEqual(
  outboundContent({
    to: "recipient@example.net",
    subject: "Image fallback",
    content: '<head><style>hidden</style></head><p>Hello&nbsp;<strong>world</strong></p><img src="pixel" alt="chart &amp; summary"><script>alert(1)</script>',
    format: "html",
  }),
  {
    text: "Hello world\nchart & summary",
    html: '<!doctype html><html><head><meta charset="utf-8"></head><body><head><style>hidden</style></head><p>Hello&nbsp;<strong>world</strong></p><img src="pixel" alt="chart &amp; summary"><script>alert(1)</script></body></html>',
  },
)
assert.equal(
  outboundContent({
    to: "recipient@example.net",
    subject: "Image-only message",
    content: '<img src="pixel">',
    format: "html",
  }).text,
  "Image-only message",
)
const adversarialHtml = "<script>".repeat(250_000)
const conversionStarted = performance.now()
assert.equal(
  outboundContent({
    to: "recipient@example.net",
    subject: "Adversarial fallback",
    content: adversarialHtml,
    format: "html",
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
    { to: "recipient@example.net", subject: "SMTP policy test", content: "<p>smtp hello</p>", format: "html" },
    smtpPolicy,
  )
} finally {
  await new Promise<void>(resolve => smtpServer.close(() => resolve()))
}
assert.match(smtpRaw, /Subject: SMTP policy test/)
assert.match(smtpRaw, /smtp (?:=\r?\n)?hello/)
assert.match(smtpRaw, /<html/i)
assert.match(smtpRaw, /Content-Type: text\/plain/i)
assert.match(smtpRaw, /smtp hello/i)
assert.equal(smtpAuthenticated, true)

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
  smtpConnectionAndAuthenticationVerified: true,
  smtpLegacyConfigDefaultsToAuto: true,
  smtpForcedLoginVerified: true,
  htmlDocumentAndTextAlternativeVerified: true,
  emperorPolicyImmutableInCode: true,
  roleAndUserDomainRestrictionsVerified: true,
  legacyAccessPolicyMigratesToAllDomains: true,
}))
