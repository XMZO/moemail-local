import assert from "node:assert/strict"
import { createServer } from "node:net"
import {
  createDefaultAccessPolicies,
  EMPEROR_ACCESS_POLICY,
  parseAccessPolicies,
} from "../../app/lib/access-policies"
import { domainPoliciesSchema, type DomainPolicy } from "../../app/lib/domain-policies"
import { sendOutboundMessage, testSmtpConnection } from "../../app/lib/outbound-mail"
import { PERMISSIONS } from "../../app/lib/permissions"

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
assert.equal(accessDefaults.roles.duke.quotas.dailySendLimit, 5)
assert.equal(accessDefaults.roles.knight.quotas.dailySendLimit, 2)
assert.ok(Object.values(PERMISSIONS).every(permission => EMPEROR_ACCESS_POLICY.permissions[permission]))
assert.equal(EMPEROR_ACCESS_POLICY.quotas.dailySendLimit, 0)
assert.equal(EMPEROR_ACCESS_POLICY.quotas.maxMessageBytes, 0)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY), true)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY.permissions), true)
assert.equal(Object.isFrozen(EMPEROR_ACCESS_POLICY.quotas), true)

const originalFetch = globalThis.fetch
let resendRequest: Request | null = null
globalThis.fetch = async (input, init) => {
  resendRequest = new Request(input, init)
  return Response.json({ id: "mail_test" }, { status: 200 })
}
try {
  await sendOutboundMessage(
    "sender@resend.example",
    { to: "recipient@example.net", subject: "Policy test", content: "<b>hello</b>" },
    domainPolicies[0],
  )
} finally {
  globalThis.fetch = originalFetch
}
assert.ok(resendRequest)
const capturedResendRequest = resendRequest as unknown as Request
assert.equal(capturedResendRequest.headers.get("authorization"), "Bearer re_test_domain_one")
assert.equal(capturedResendRequest.redirect, "manual")
const resendBody = await capturedResendRequest.json() as { from: string; to: string[] }
assert.equal(resendBody.from, "Domain One <sender@resend.example>")
assert.deepEqual(resendBody.to, ["recipient@example.net"])

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
    { to: "recipient@example.net", subject: "SMTP policy test", content: "<p>smtp hello</p>" },
    smtpPolicy,
  )
} finally {
  await new Promise<void>(resolve => smtpServer.close(() => resolve()))
}
assert.match(smtpRaw, /Subject: SMTP policy test/)
assert.match(smtpRaw, /smtp hello/)
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
  emperorPolicyImmutableInCode: true,
}))
