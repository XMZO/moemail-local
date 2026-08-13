import {
  createMailboxNameBlock,
  deleteMailboxNameBlock,
  listMailboxNameBlocks,
} from "@/lib/mailbox-name-blocks"
import { apiError } from "@/lib/api-response"
import { ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const headers = { "Cache-Control": "private, no-store" }

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
  const payload = await request.json().catch(() => null) as {
    scope?: unknown
    userId?: unknown
    localPart?: unknown
    domain?: unknown
  } | null
  if (
    !payload
    || (payload.scope !== "global" && payload.scope !== "user")
    || typeof payload.localPart !== "string"
    || typeof payload.domain !== "string"
    || (payload.userId !== undefined && typeof payload.userId !== "string")
  ) return apiError("INVALID_REQUEST", 400, { headers })
  try {
    const block = await createMailboxNameBlock({
      scope: payload.scope,
      userId: payload.userId,
      localPart: payload.localPart,
      domain: payload.domain,
    })
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
