import {
  createMailboxNameBlock,
  deleteMailboxNameBlock,
  listMailboxNameBlocks,
  updateMailboxNameBlock,
} from "@/lib/mailbox-name-blocks"
import { RESERVABLE_MAILBOX_ROLES } from "@/lib/mailbox-block-scope"
import { apiError } from "@/lib/api-response"
import { ROLES, type Role } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }
const allowedRoleNames = new Set<string>(RESERVABLE_MAILBOX_ROLES)

type MailboxBlockPayload = {
  scope: "global" | "user" | "roles"
  userId?: string
  allowedRoles?: Role[]
  localPart: string
  domain: string
}

function parseMailboxBlockPayload(value: unknown): MailboxBlockPayload | null {
  const payload = value as {
    scope?: unknown
    userId?: unknown
    allowedRoles?: unknown
    localPart?: unknown
    domain?: unknown
  } | null
  if (
    !payload
    || (payload.scope !== "global" && payload.scope !== "user" && payload.scope !== "roles")
    || typeof payload.localPart !== "string"
    || typeof payload.domain !== "string"
    || (payload.scope === "global" && (payload.userId !== undefined || payload.allowedRoles !== undefined))
    || (payload.scope === "user" && (
      typeof payload.userId !== "string"
      || payload.userId.length === 0
      || payload.allowedRoles !== undefined
    ))
    || (payload.scope === "roles" && (
      payload.userId !== undefined
      || !Array.isArray(payload.allowedRoles)
      || payload.allowedRoles.length > RESERVABLE_MAILBOX_ROLES.length
      || payload.allowedRoles.some(role => typeof role !== "string" || !allowedRoleNames.has(role))
      || new Set(payload.allowedRoles).size !== payload.allowedRoles.length
    ))
  ) return null
  return {
    scope: payload.scope,
    userId: typeof payload.userId === "string" ? payload.userId : undefined,
    allowedRoles: payload.allowedRoles as Role[] | undefined,
    localPart: payload.localPart,
    domain: payload.domain,
  }
}

async function authorizeEmperor(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization
  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return { ok: false as const, response: apiError("EMPEROR_REQUIRED", 403, { headers }) }
  }
  return authorization
}

export async function GET(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response
  try {
    return Response.json({ blocks: await listMailboxNameBlocks() }, { headers })
  } catch (error) {
    console.error("mailbox_block.read_failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return apiError("MAILBOX_BLOCKS_READ_FAILED", 500, { headers })
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response
  const payload = parseMailboxBlockPayload(await request.json().catch(() => null))
  if (!payload) return apiError("INVALID_REQUEST", 400, { headers })
  try {
    const block = await createMailboxNameBlock(payload)
    return Response.json({ block }, { status: 201, headers })
  } catch (error) {
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return apiError("USER_NOT_FOUND", 404, { headers })
    }
    if (error instanceof Error && ["INVALID_MAILBOX_BLOCK_ADDRESS", "MAILBOX_BLOCK_USER_REQUIRED"].includes(error.message)) {
      return apiError("INVALID_MAILBOX_BLOCK", 400, { headers })
    }
    console.error("mailbox_block.create_failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return apiError("MAILBOX_BLOCK_CREATE_FAILED", 500, { headers })
  }
}

export async function PUT(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response
  const id = new URL(request.url).searchParams.get("id")
  if (!id) return apiError("INVALID_REQUEST", 400, { headers })
  const payload = parseMailboxBlockPayload(await request.json().catch(() => null))
  if (!payload) return apiError("INVALID_REQUEST", 400, { headers })
  try {
    const block = await updateMailboxNameBlock(id, payload)
    return block
      ? Response.json({ block }, { headers })
      : apiError("MAILBOX_BLOCK_NOT_FOUND", 404, { headers })
  } catch (error) {
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return apiError("USER_NOT_FOUND", 404, { headers })
    }
    if (error instanceof Error && error.message === "MAILBOX_BLOCK_CONFLICT") {
      return apiError("MAILBOX_BLOCK_CONFLICT", 409, { headers })
    }
    if (error instanceof Error && ["INVALID_MAILBOX_BLOCK_ADDRESS", "MAILBOX_BLOCK_USER_REQUIRED"].includes(error.message)) {
      return apiError("INVALID_MAILBOX_BLOCK", 400, { headers })
    }
    console.error("mailbox_block.update_failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return apiError("MAILBOX_BLOCK_UPDATE_FAILED", 500, { headers })
  }
}

export async function DELETE(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response
  const id = new URL(request.url).searchParams.get("id")
  if (!id) return apiError("INVALID_REQUEST", 400, { headers })
  try {
    return await deleteMailboxNameBlock(id)
      ? Response.json({ ok: true }, { headers })
      : apiError("MAILBOX_BLOCK_NOT_FOUND", 404, { headers })
  } catch (error) {
    console.error("mailbox_block.delete_failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return apiError("MAILBOX_BLOCK_DELETE_FAILED", 500, { headers })
  }
}
