import { NextResponse } from "next/server"
import {
  parseConfigDocument,
  readConfigFile,
  stringifyConfig,
} from "@/lib/config/file"
import {
  getConfig,
  getConfigStatus,
  configFingerprint,
  reloadConfig,
  saveConfig,
} from "@/lib/config/runtime"
import { parseConfig } from "@/lib/config/schema"
import { checkDriverBinding } from "@/lib/db"
import { ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie",
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: noStoreHeaders })
}

async function authorizeEmperor(request: Request) {
  const authorization = await authorizeRequest(request)
  if (!authorization.ok) {
    for (const [name, value] of Object.entries(noStoreHeaders)) {
      authorization.response.headers.set(name, value)
    }
    return { ok: false as const, response: authorization.response }
  }

  if (!authorization.principal.roles.includes(ROLES.EMPEROR)) {
    return {
      ok: false as const,
      response: json({ error: "仅皇帝可以查看或修改运行配置" }, 403),
    }
  }

  return { ok: true as const }
}

function readYaml() {
  const status = getConfigStatus()
  const snapshot = readConfigFile(status.path)
  const yaml = snapshot?.raw ?? stringifyConfig(getConfig())
  return {
    yaml,
    fingerprint: configFingerprint(snapshot?.raw ?? null),
    status,
  }
}

export async function GET(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  try {
    await reloadConfig()
    const { yaml, fingerprint, status } = readYaml()
    return json({
      yaml,
      fingerprint,
      revision: status.revision,
      path: status.path,
      status,
    })
  } catch (error) {
    console.error("Failed to read runtime config:", error)
    return json({ error: "读取运行配置失败" }, 500)
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json({ error: "请求格式无效", issues: [] }, 400)
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json({ error: "请求格式无效", issues: [] }, 400)
  }

  const { yaml, fingerprint } = payload as { yaml?: unknown; fingerprint?: unknown }
  if (typeof yaml !== "string") {
    return json({
      error: "必须提供 YAML 配置文本",
      issues: [{ path: "yaml", message: "必须是字符串" }],
    }, 400)
  }
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    return json({
      error: "配置文件指纹无效",
      issues: [{ path: "fingerprint", message: "必须先重新加载当前配置" }],
    }, 400)
  }

  let document: unknown
  try {
    document = parseConfigDocument(yaml)
  } catch (error) {
    return json({
      error: "YAML 解析失败",
      issues: [{
        path: "(file)",
        message: error instanceof Error ? error.message : String(error),
      }],
    }, 400)
  }

  const parsed = parseConfig(document)
  if (!parsed.ok) {
    return json({ error: "配置校验未通过", issues: parsed.issues }, 400)
  }

  try {
    const result = await saveConfig(parsed.config, {
      expectedFingerprint: fingerprint as string,
    })

    if (!result.ok) {
      const conflict = result.issues.some(issue => (
        issue.path === "(revision)" || issue.path === "(fingerprint)"
      ))
      return json({
        error: conflict ? "配置已被其他修改更新" : "配置未应用",
        issues: result.issues,
      }, conflict ? 409 : 400)
    }

    checkDriverBinding()
    const status = getConfigStatus()
    return json({
      ok: true,
      yaml: stringifyConfig(result.config),
      fingerprint: configFingerprint(stringifyConfig(result.config)),
      revision: result.revision,
      path: status.path,
      restartRequired: result.restartRequired || Boolean(status.restartRequired),
      restartReason: status.restartRequired?.reason ?? null,
      status,
    })
  } catch (error) {
    console.error("Failed to save runtime config:", error)
    return json({ error: "保存运行配置失败", issues: [] }, 500)
  }
}
