import { randomBytes } from "node:crypto"
import { z } from "zod"
import { apiError, apiIssues } from "@/lib/api-response"
import { PERMISSIONS } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { isSameOriginMutation } from "@/lib/request-origin"
import { MailuClient } from "@/lib/mailu/client"
import {
  defaultMailuIntegration,
  getMailuIntegration,
  mailuIntegrationFieldsSchema,
  mailuIntegrationSchema,
  saveMailuIntegration,
} from "@/lib/mailu/config"
import { testMailuImapConnection } from "@/lib/mailu/inbound"
import { testMailuSmtpConnection } from "@/lib/mailu/outbound"
import {
  reconcileMailu,
  rotateMailuServiceCredentials,
  withMailuMutation,
} from "@/lib/mailu/reconcile"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }
const apiActionIntegrationSchema = mailuIntegrationFieldsSchema
  .pick({ api: true })
  .strip()
  .superRefine((integration, ctx) => {
    if (integration.api.token === "replace-me") ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["api", "token"],
      message: "MAILU_PLACEHOLDER_SECRET_FORBIDDEN",
    })
  })
const imapActionIntegrationSchema = mailuIntegrationFieldsSchema
  .pick({ collector: true, imap: true, retention: true })
  .strip()
  .superRefine((integration, ctx) => {
    if (integration.collector.password === "replace-me") ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["collector", "password"],
      message: "MAILU_PLACEHOLDER_SECRET_FORBIDDEN",
    })
  })
const smtpActionIntegrationSchema = mailuIntegrationFieldsSchema
  .pick({ collector: true, smtp: true })
  .strip()
  .superRefine((integration, ctx) => {
    if (integration.collector.password === "replace-me") ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["collector", "password"],
      message: "MAILU_PLACEHOLDER_SECRET_FORBIDDEN",
    })
  })
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discover"), integration: apiActionIntegrationSchema }).strict(),
  z.object({ kind: z.literal("testApi"), integration: apiActionIntegrationSchema }).strict(),
  z.object({ kind: z.literal("testImap"), integration: imapActionIntegrationSchema }).strict(),
  z.object({ kind: z.literal("testSmtp"), integration: smtpActionIntegrationSchema }).strict(),
  z.object({ kind: z.literal("reconcile") }).strict(),
])

async function authorizeMailu(request: Request) {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (!isSameOriginMutation(request)) {
      return { ok: false as const, response: apiError("PERMISSION_DENIED", 403, { headers }) }
    }
  }
  const authorization = await authorizeRequest(request, { permission: PERMISSIONS.MANAGE_MAILU })
  if (!authorization.ok) return authorization
  // Mailu API tokens and service-account passwords must never be retrievable or
  // rotatable through a long-lived MoeMail API key, even when that key's owner
  // has the UI permission.
  if (authorization.principal.kind !== "session") {
    return { ok: false as const, response: apiError("API_KEY_ROUTE_FORBIDDEN", 403, { headers }) }
  }
  return authorization
}

function safeProviderError(error: unknown, integration?: {
  api?: { token?: string }
  collector?: { password?: string }
  catchAll?: { password?: string }
}) {
  let message = error instanceof Error ? error.message : "unknown"
  for (const secret of [
    integration?.api?.token,
    integration?.collector?.password,
    integration?.catchAll?.password,
  ].filter((value): value is string => Boolean(value))) message = message.replaceAll(secret, "[redacted]")
  return message.replace(/[\r\n\0]+/gu, " ").slice(0, 300)
}

function validationDetails(error: z.ZodError) {
  return { issues: apiIssues(error.issues.map(issue => ({ path: issue.path.join(".") }))) }
}

export async function GET(request: Request) {
  const authorization = await authorizeMailu(request)
  if (!authorization.ok) return authorization.response
  try {
    const stored = await getMailuIntegration()
    return Response.json({
      integration: stored ?? defaultMailuIntegration(),
      configured: Boolean(stored),
    }, { headers })
  } catch (error) {
    console.error("mailu.config_read_failed", { message: safeProviderError(error) })
    return apiError("MAILU_CONFIG_READ_FAILED", 500, { headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeMailu(request)
  if (!authorization.ok) return authorization.response
  let payload: unknown
  try { payload = await request.json() } catch { return apiError("INVALID_JSON", 400, { headers }) }
  const parsed = mailuIntegrationSchema.safeParse(payload)
  if (!parsed.success) return apiError("MAILU_CONFIG_INVALID", 400, {
    headers,
    details: validationDetails(parsed.error),
  })
  try {
    const integration = await withMailuMutation(async () => {
      const previous = await getMailuIntegration().catch(() => null)
      if (
        previous?.enabled
        && parsed.data.enabled
        && (
          previous.collector.address !== parsed.data.collector.address
          || previous.catchAll.address !== parsed.data.catchAll.address
          || previous.integrationId !== parsed.data.integrationId
        )
      ) throw new Error("MAILU_IDENTITY_CHANGE_REQUIRES_DISABLE")
      if (
        previous?.enabled
        && parsed.data.enabled
        && (
          previous.collector.password !== parsed.data.collector.password
          || previous.catchAll.password !== parsed.data.catchAll.password
        )
      ) throw new Error("MAILU_CREDENTIAL_ROTATION_REQUIRED")
      return saveMailuIntegration(parsed.data)
    })
    return Response.json({ ok: true, integration }, { headers })
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === "MAILU_IDENTITY_CHANGE_REQUIRES_DISABLE"
        || error.message === "MAILU_CREDENTIAL_ROTATION_REQUIRED"
      )
    ) return apiError(error.message, 409, { headers })
    console.error("mailu.config_save_failed", { message: safeProviderError(error, parsed.data) })
    return apiError("MAILU_CONFIG_SAVE_FAILED", 500, { headers })
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeMailu(request)
  if (!authorization.ok) return authorization.response
  let payload: unknown
  try { payload = await request.json() } catch { return apiError("INVALID_JSON", 400, { headers }) }
  const parsed = actionSchema.safeParse(payload)
  if (!parsed.success) return apiError("MAILU_CONFIG_INVALID", 400, {
    headers,
    details: validationDetails(parsed.error),
  })

  let sensitiveInput: Parameters<typeof safeProviderError>[1]
  try {
    if (parsed.data.kind === "testImap") {
      sensitiveInput = parsed.data.integration
      return Response.json(await testMailuImapConnection(parsed.data.integration), { headers })
    }
    if (parsed.data.kind === "testSmtp") {
      sensitiveInput = parsed.data.integration
      return Response.json(await testMailuSmtpConnection(parsed.data.integration), { headers })
    }
    if (parsed.data.kind === "reconcile") {
      let integration
      try {
        integration = await getMailuIntegration()
      } catch (error) {
        console.error("mailu.config_read_failed", { message: safeProviderError(error) })
        return apiError("MAILU_CONFIG_READ_FAILED", 500, { headers })
      }
      if (!integration) return apiError("MAILU_CONFIG_REQUIRED", 409, { headers })
      sensitiveInput = integration
      if (!integration.enabled) return apiError("MAILU_INTEGRATION_DISABLED", 409, { headers })
      return Response.json(await reconcileMailu(integration), { headers })
    }
    sensitiveInput = parsed.data.integration
    const inventory = await new MailuClient(parsed.data.integration).listInventory()
    return Response.json({
      ok: true,
      domains: inventory.domains.map(domain => domain.name).sort(),
      ...(parsed.data.kind === "discover" ? {
        users: inventory.users.length,
        aliases: inventory.aliases.length,
      } : {}),
    }, { headers })
  } catch (error) {
    console.error("mailu.action_failed", {
      kind: parsed.data.kind,
      message: safeProviderError(error, sensitiveInput),
    })
    return apiError("MAILU_CONNECTION_FAILED", 502, { headers })
  }
}

export async function PATCH(request: Request) {
  const authorization = await authorizeMailu(request)
  if (!authorization.ok) return authorization.response
  let payload: unknown
  try { payload = await request.json() } catch { return apiError("INVALID_JSON", 400, { headers }) }
  const parsed = z.object({ rotate: z.enum(["collector", "catchAll", "all"]) }).strict().safeParse(payload)
  if (!parsed.success) return apiError("MAILU_CONFIG_INVALID", 400, { headers })
  let integration
  try { integration = await getMailuIntegration() } catch {
    return apiError("MAILU_CONFIG_READ_FAILED", 500, { headers })
  }
  if (!integration) return apiError("MAILU_CONFIG_REQUIRED", 409, { headers })
  try {
    const next = await withMailuMutation(async () => {
      // Re-read after acquiring the mutation lock. Two concurrent rotations
      // must never leave Mailu using one password while the local database
      // commits the other request's stale value.
      const current = await getMailuIntegration()
      if (!current) throw new Error("MAILU_CONFIG_REQUIRED")
      if (!current.enabled) throw new Error("MAILU_INTEGRATION_DISABLED")
      const candidate = structuredClone(current)
      const generated = () => randomBytes(32).toString("base64url")
      if (parsed.data.rotate === "collector" || parsed.data.rotate === "all") candidate.collector.password = generated()
      if (parsed.data.rotate === "catchAll" || parsed.data.rotate === "all") candidate.catchAll.password = generated()
      try {
        // This can partially succeed when rotating both accounts. Keep the
        // compensating write around the remote mutation as well as the local
        // commit so either failure point attempts to restore the working pair.
        await rotateMailuServiceCredentials(candidate, parsed.data.rotate)
        await saveMailuIntegration(candidate)
      } catch (error) {
        // Compensate a partial remote update or a failed local credential
        // commit. This preserves the previous pair whenever Mailu is reachable.
        await rotateMailuServiceCredentials(current, parsed.data.rotate).catch(rollbackError => {
          console.error("mailu.credentials_rotate_rollback_failed", {
            message: safeProviderError(rollbackError, current),
          })
        })
        throw error
      }
      return candidate
    })
    return Response.json({ ok: true, integration: next }, { headers })
  } catch (error) {
    if (error instanceof Error && error.message === "MAILU_CONFIG_REQUIRED") {
      return apiError("MAILU_CONFIG_REQUIRED", 409, { headers })
    }
    if (error instanceof Error && error.message === "MAILU_INTEGRATION_DISABLED") {
      return apiError("MAILU_INTEGRATION_DISABLED", 409, { headers })
    }
    console.error("mailu.credentials_rotate_failed", { message: safeProviderError(error, integration) })
    return apiError("MAILU_CREDENTIAL_ROTATION_FAILED", 502, { headers })
  }
}
