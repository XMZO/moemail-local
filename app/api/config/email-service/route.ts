import { NextResponse } from "next/server"
import { PERMISSIONS } from "@/lib/permissions"
import { EMAIL_CONFIG } from "@/config"
import { CONFIG_KEYS, getConfigValues, setConfigValues } from "@/lib/config-store"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"

interface EmailServiceConfig {
  enabled: boolean
  apiKey: string
  roleLimits: {
    duke?: number
    knight?: number
  }
}

export async function GET(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response

  try {
    const config = await getConfigValues([
      CONFIG_KEYS.EMAIL_SERVICE_ENABLED,
      CONFIG_KEYS.RESEND_API_KEY,
      CONFIG_KEYS.EMAIL_ROLE_LIMITS,
    ])
    const enabled = config.EMAIL_SERVICE_ENABLED
    const apiKey = config.RESEND_API_KEY
    const roleLimits = config.EMAIL_ROLE_LIMITS

    const customLimits = roleLimits ? JSON.parse(roleLimits) : {}
    
    const finalLimits = {
      duke: customLimits.duke !== undefined ? customLimits.duke : EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.duke,
      knight: customLimits.knight !== undefined ? customLimits.knight : EMAIL_CONFIG.DEFAULT_DAILY_SEND_LIMITS.knight,
    }

    return NextResponse.json({
      enabled: enabled === "true",
      apiKey: apiKey || "",
      roleLimits: finalLimits
    })
  } catch (error) {
    console.error("Failed to get email service config:", error)
    return NextResponse.json(
      { error: "获取 Resend 发件服务配置失败" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeRequest(request, {
    permission: PERMISSIONS.MANAGE_CONFIG,
  })
  if (!authorization.ok) return authorization.response

  try {
    const config = await request.json() as EmailServiceConfig

    if (config.enabled && !config.apiKey) {
      return NextResponse.json(
        { error: "启用 Resend 时，API Key 为必填项" },
        { status: 400 }
      )
    }

    const customLimits: { duke?: number; knight?: number } = {}
    if (config.roleLimits?.duke !== undefined) {
      customLimits.duke = config.roleLimits.duke
    }
    if (config.roleLimits?.knight !== undefined) {
      customLimits.knight = config.roleLimits.knight
    }

    await setConfigValues({
      EMAIL_SERVICE_ENABLED: config.enabled.toString(),
      RESEND_API_KEY: config.apiKey,
      EMAIL_ROLE_LIMITS: JSON.stringify(customLimits),
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to save email service config:", error)
    return NextResponse.json(
      { error: "保存 Resend 发件服务配置失败" },
      { status: 500 }
    )
  }
}
