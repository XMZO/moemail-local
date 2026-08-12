import { NextResponse } from "next/server"
import { checkSendPermission } from "@/lib/send-permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { createDb } from "@/lib/db"
import { emails } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { resolveOutboundPolicy } from "@/lib/outbound-mail"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const authorization = await authorizeRequest(request, {
      permission: PERMISSIONS.SEND_EMAIL,
    })
    if (!authorization.ok) return authorization.response

    const { userId, access } = authorization.principal
    const emailId = new URL(request.url).searchParams.get("emailId")
    if (emailId) {
      const email = await createDb().query.emails.findFirst({ where: eq(emails.id, emailId) })
      if (!email) return NextResponse.json({ canSend: false, error: "邮箱不存在" }, { status: 404 })
      if (email.userId !== userId) return NextResponse.json({ canSend: false, error: "无权访问此邮箱" }, { status: 403 })
      const policy = await resolveOutboundPolicy(email.address)
      if (!policy || policy.outbound.mode === "disabled") {
        return NextResponse.json({ canSend: false, error: "该邮箱域名未启用发件" })
      }
    }

    const result = await checkSendPermission(userId, false, access)
    
    return NextResponse.json(result)
  } catch (error) {
    console.error('Failed to check send permission:', error)
    return NextResponse.json(
      { 
        canSend: false, 
        error: "权限检查失败" 
      },
      { status: 500 }
    )
  }
}
