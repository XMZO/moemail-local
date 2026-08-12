import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { emails, messages } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { checkSendPermission, withUserSendLock } from "@/lib/send-permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"
import { outboundMessageSchema, resolveOutboundPolicy, sendOutboundMessage } from "@/lib/outbound-mail"

export const runtime = "nodejs"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authorization = await authorizeRequest(request, {
      permission: PERMISSIONS.SEND_EMAIL,
    })
    if (!authorization.ok) return authorization.response

    const { userId, access } = authorization.principal

    const { id } = await params
    const db = createDb()

    const payload = await request.json().catch(() => null)
    const parsedMessage = outboundMessageSchema.safeParse(payload)
    if (!parsedMessage.success) {
      return NextResponse.json(
        { error: parsedMessage.error.issues[0]?.message ?? "发件内容无效" },
        { status: 400 }
      )
    }

    const email = await db.query.emails.findFirst({
      where: eq(emails.id, id)
    })

    if (!email) {
      return NextResponse.json(
        { error: "邮箱不存在" },
        { status: 404 }
      )
    }

    if (email.userId !== userId) {
      return NextResponse.json(
        { error: "无权访问此邮箱" },
        { status: 403 }
      )
    }

    const domainPolicy = await resolveOutboundPolicy(email.address)
    if (!domainPolicy || domainPolicy.outbound.mode === "disabled") {
      return NextResponse.json(
        { error: "该邮箱域名未启用发件" },
        { status: 409 }
      )
    }

    return await withUserSendLock(userId, async () => {
      const permissionResult = await checkSendPermission(userId, false, access)
      if (!permissionResult.canSend) {
        return NextResponse.json(
          { error: permissionResult.error },
          { status: 403 }
        )
      }

      const { message } = await sendOutboundMessage(
        email.address,
        parsedMessage.data,
        domainPolicy,
      )
      await db.insert(messages).values({
        emailId: email.id,
        fromAddress: email.address,
        toAddress: message.to,
        subject: message.subject,
        content: "",
        type: "sent",
        html: message.content,
      })

      const remainingEmails = permissionResult.remainingEmails === undefined
        ? undefined
        : Math.max(0, permissionResult.remainingEmails - 1)
      return NextResponse.json({
        success: true,
        message: "邮件发送成功",
        remainingEmails,
        transport: domainPolicy.outbound.mode,
      })
    })
  } catch (error) {
    console.error("outbound.send.failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error === "object" && error !== null && "code" in error
        ? String(error.code).slice(0, 100)
        : "unknown",
    })
    return NextResponse.json(
      { error: "发送邮件失败，请检查该域名的发件配置" },
      { status: 502 }
    )
  }
}
