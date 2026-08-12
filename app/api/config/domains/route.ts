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

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }

function validationIssues(error: z.ZodError) {
  return error.issues.map(issue => ({
    path: issue.path.join("."),
    message: issue.message,
  }))
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
    console.error("Failed to load domain policies:", error)
    return Response.json({ error: "读取域名策略失败" }, { status: 500, headers })
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
    return Response.json({ error: "请求格式无效", issues: [] }, { status: 400, headers })
  }

  const input = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as { policies?: unknown }).policies
    : undefined
  const parsed = domainPoliciesSchema.safeParse(input)
  if (!parsed.success) {
    return Response.json({
      error: "域名策略校验未通过",
      issues: validationIssues(parsed.error),
    }, { status: 400, headers })
  }

  try {
    const policies = await saveDomainPolicies(parsed.data)
    return Response.json({ ok: true, policies }, { headers })
  } catch (error) {
    console.error("Failed to save domain policies:", error)
    return Response.json({ error: "保存域名策略失败" }, { status: 500, headers })
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
    return Response.json({ error: "请求格式无效" }, { status: 400, headers })
  }
  const parsed = connectionTestSchema.safeParse(payload)
  if (!parsed.success) {
    return Response.json({
      error: "邮件服务器配置校验未通过",
      issues: validationIssues(parsed.error),
    }, { status: 400, headers })
  }

  try {
    const result = parsed.data.kind === "imap"
      ? await testImapConnection(parsed.data.policy)
      : await testSmtpConnection(parsed.data.policy)
    return Response.json(result, { headers })
  } catch (error) {
    const policy = parsed.data.policy
    console.error("Mail server connection test failed", {
      kind: parsed.data.kind,
      message: safeProviderError(error, [
        policy.username ?? "",
        policy.password ?? "",
      ]),
    })
    return Response.json(
      { error: `连接 ${parsed.data.kind.toUpperCase()} 失败，请检查服务器、端口、加密方式和凭据` },
      { status: 502, headers },
    )
  }
}
