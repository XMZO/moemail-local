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
import { createDefaultConfig, parseConfig } from "@/lib/config/schema"
import { checkDriverBinding } from "@/lib/db"
import { ROLES } from "@/lib/permissions"
import { authorizeRequest } from "@/lib/request-auth"
import { apiErrorBody, apiIssues } from "@/lib/api-response"

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
      response: json(apiErrorBody("EMPEROR_REQUIRED"), 403),
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
    config: getConfig(),
    fingerprint: configFingerprint(snapshot?.raw ?? null),
    status,
  }
}

export async function GET(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  try {
    await reloadConfig()
    const { yaml, config, fingerprint, status } = readYaml()
    return json({
      yaml,
      config,
      defaults: createDefaultConfig(),
      fingerprint,
      revision: status.revision,
      path: status.path,
      status,
    })
  } catch (error) {
    console.error("runtime_config.read_failed", error)
    return json(apiErrorBody("RUNTIME_CONFIG_READ_FAILED"), 500)
  }
}

export async function POST(request: Request) {
  const authorization = await authorizeEmperor(request)
  if (!authorization.ok) return authorization.response

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json(apiErrorBody("INVALID_JSON", { issues: [] }), 400)
  }

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json(apiErrorBody("INVALID_REQUEST", { issues: [] }), 400)
  }

  const { yaml, config, fingerprint } = payload as {
    yaml?: unknown
    config?: unknown
    fingerprint?: unknown
  }
  if (typeof yaml !== "string" && config === undefined) {
    return json(apiErrorBody("CONFIG_CONTENT_REQUIRED", {
      issues: apiIssues([{ path: "config" }], "CONFIG_CONTENT_REQUIRED"),
    }), 400)
  }
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    return json(apiErrorBody("CONFIG_FINGERPRINT_INVALID", {
      issues: apiIssues([{ path: "fingerprint" }], "CONFIG_FINGERPRINT_INVALID"),
    }), 400)
  }

  let document: unknown = config
  if (typeof yaml === "string") {
    try {
      document = parseConfigDocument(yaml)
    } catch (error) {
      console.error("runtime_config.yaml_parse_failed", error)
      return json(apiErrorBody("YAML_PARSE_FAILED", {
        issues: apiIssues([{ path: "(file)" }], "YAML_PARSE_FAILED"),
      }), 400)
    }
  }

  const parsed = parseConfig(document)
  if (!parsed.ok) {
    return json(apiErrorBody("CONFIG_VALIDATION_FAILED", {
      issues: apiIssues(parsed.issues),
    }), 400)
  }

  try {
    const result = await saveConfig(parsed.config, {
      expectedFingerprint: fingerprint as string,
    })

    if (!result.ok) {
      const conflict = result.issues.some(issue => (
        issue.path === "(revision)" || issue.path === "(fingerprint)"
      ))
      return json(apiErrorBody(
        conflict ? "CONFIG_CONFLICT" : "CONFIG_NOT_APPLIED",
        { issues: apiIssues(result.issues) },
      ), conflict ? 409 : 400)
    }

    checkDriverBinding()
    const status = getConfigStatus()
    return json({
      ok: true,
      yaml: stringifyConfig(result.config),
      config: result.config,
      defaults: createDefaultConfig(),
      fingerprint: configFingerprint(stringifyConfig(result.config)),
      revision: result.revision,
      path: status.path,
      restartRequired: result.restartRequired || Boolean(status.restartRequired),
      restartReason: status.restartRequired?.reason ?? null,
      status,
    })
  } catch (error) {
    console.error("runtime_config.save_failed", error)
    return json(apiErrorBody("RUNTIME_CONFIG_SAVE_FAILED", { issues: [] }), 500)
  }
}
