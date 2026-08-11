import { NextResponse } from "next/server"
import { checkSendPermission } from "@/lib/send-permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { PERMISSIONS } from "@/lib/permissions"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const authorization = await authorizeRequest(request, {
      permission: PERMISSIONS.MANAGE_EMAIL,
    })
    if (!authorization.ok) return authorization.response

    const result = await checkSendPermission(authorization.principal.userId)
    
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
