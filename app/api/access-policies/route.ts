import { createDefaultAccessPolicies, getAccessPolicies, updateAccessPolicies } from "@/lib/access-policies"
import { PERMISSIONS, ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { getDomainPolicies } from "@/lib/domain-policies"
import { apiError } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }

async function authorizeEmperor(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization
  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return {
      ok: false as const,
      response: apiError("EMPEROR_REQUIRED", 403, { headers }),
    }
  }
  return authorization
}

export async function GET(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  try {
    const [policies, domainPolicies] = await Promise.all([
      getAccessPolicies(),
      getDomainPolicies(),
    ])
    return Response.json({
      policies,
      defaults: createDefaultAccessPolicies(),
      permissions: Object.values(PERMISSIONS),
      domains: domainPolicies.map(policy => policy.domain),
    }, { headers })
  } catch (error) {
    console.error("access_policy.read_failed", error)
    return apiError("ACCESS_POLICIES_READ_FAILED", 500, { headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return apiError("INVALID_JSON", 400, { headers })
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return apiError("INVALID_REQUEST", 400, { headers })
  }

  try {
    const { roles, mailQuotaRules } = payload as { roles?: unknown; mailQuotaRules?: unknown }
    const policies = await updateAccessPolicies(current => ({
      ...current,
      ...(roles === undefined ? {} : { roles }),
      ...(mailQuotaRules === undefined ? {} : { mailQuotaRules }),
    }))
    void import("@/lib/mailu/reconcile")
      .then(({ reconcileCurrentMailuIfEnabled }) => reconcileCurrentMailuIfEnabled())
      .catch(error => console.error("mailu.reconcile_after_access_policy_change_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      }))
    return Response.json({ ok: true, policies }, { headers })
  } catch (error) {
    console.error("access_policy.save_failed", error)
    return apiError("ACCESS_POLICIES_SAVE_FAILED", 400, { headers })
  }
}
