import { createHash, timingSafeEqual } from "node:crypto"
import { claimEmperor } from "@/lib/emperor"
import { authorizeRequest } from "@/lib/request-auth"
import { getConfig } from "@/lib/config/runtime"

export const runtime = "nodejs"

function secretMatches(supplied: string, expected: string) {
  const suppliedDigest = createHash("sha256").update(supplied).digest()
  const expectedDigest = createHash("sha256").update(expected).digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) return authorization.response

  const expectedSecret = getConfig().auth.emperorBootstrapSecret
  if (!expectedSecret) {
    return Response.json(
      { error: "兼容登基接口已禁用；首次站主请使用初始化/恢复向导创建" },
      { status: 503 },
    )
  }

  let suppliedSecret = ""
  try {
    const body = await request.json() as { secret?: unknown }
    suppliedSecret = typeof body.secret === "string" ? body.secret : ""
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400 })
  }

  if (!secretMatches(suppliedSecret, expectedSecret)) {
    return Response.json({ error: "初始化密钥无效" }, { status: 401 })
  }

  try {
    const result = await claimEmperor(authorization.principal.userId)
    if (result === "emperor_exists") {
      return Response.json({ error: "已存在皇帝, 谋反将被处死" }, { status: 409 })
    }
    return Response.json({
      message: result === "already_emperor"
        ? "你已经是皇帝了"
        : "登基成功，你已成为皇帝",
    })
  } catch (error) {
    console.error("Failed to initialize emperor:", error)
    return Response.json({ error: "登基称帝失败" }, { status: 500 })
  }
}
