import { z } from "zod"
import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import {
  domainPoliciesSchema,
  getDomainPolicies,
  imapInboundSchema,
  saveDomainPolicies,
  smtpOutboundSchema,
} from "@/lib/domain-policies"
import { testImapConnection } from "@/lib/imap-inbound"
import { testSmtpConnection } from "@/lib/outbound-mail"
import { apiError, apiIssues } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }

function validationIssues(error: z.ZodError) {
  return apiIssues(error.issues.map(issue => ({ path: issue.path.join(".") })))
}

const connectionTestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("imap"), policy: imapInboundSchema }).strict(),
  z.object({ kind: z.literal("smtp"), policy: smtpOutboundSchema }).strict(),
])

function safeProviderError(error: unknown, secrets: string[]) {
  let message = error instanceof Error ? error.message : "unknown"
  for (const secret of secrets.filter(Boolean)) message = message.replaceAll(secret, "[redacted]")
  return message.replace(/[\r\n\0]+/g, " ").slice(0, 500)
}

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response

  try {
    return Response.json({ policies: await getDomainPolicies() }, { headers })
  } catch (error) {
    console.error("domain_policy.read_failed", error)
    return apiError("DOMAIN_POLICIES_READ_FAILED", 500, { headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return apiError("INVALID_JSON", 400, { headers, details: { issues: [] } })
  }

  const input = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as { policies?: unknown }).policies
    : undefined
  const parsed = domainPoliciesSchema.safeParse(input)
  if (!parsed.success) {
    return apiError("DOMAIN_POLICIES_INVALID", 400, {
      headers,
      details: { issues: validationIssues(parsed.error) },
    })
  }

  try {
    const policies = await saveDomainPolicies(parsed.data)
    return Response.json({ ok: true, policies }, { headers })
  } catch (error) {
    console.error("domain_policy.save_failed", error)
    return apiError("DOMAIN_POLICIES_SAVE_FAILED", 500, { headers })
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return apiError("INVALID_JSON", 400, { headers })
  }
  const parsed = connectionTestSchema.safeParse(payload)
  if (!parsed.success) {
    return apiError("MAIL_SERVER_CONFIG_INVALID", 400, {
      headers,
      details: { issues: validationIssues(parsed.error) },
    })
  }

  try {
    const result = parsed.data.kind === "imap"
      ? await testImapConnection(parsed.data.policy)
      : await testSmtpConnection(parsed.data.policy)
    return Response.json(result, { headers })
  } catch (error) {
    const policy = parsed.data.policy
    console.error("domain_policy.connection_test_failed", {
      kind: parsed.data.kind,
      message: safeProviderError(error, [
        policy.username ?? "",
        policy.password ?? "",
      ]),
    })
    return apiError(
      parsed.data.kind === "imap" ? "IMAP_CONNECTION_FAILED" : "SMTP_CONNECTION_FAILED",
      502,
      { headers },
    )
  }
}
