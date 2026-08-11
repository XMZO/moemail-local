import type { AppConfig } from "../../app/lib/config/schema"
import { loadTrustedLastKnownGoodConfig } from "./trusted-config"

export async function sendOperatorAlert(
  summary: string,
  details: unknown,
  suppliedConfig?: AppConfig["monitor"],
) {
  const monitorConfig = suppliedConfig ?? loadTrustedLastKnownGoodConfig().monitor
  const alertUrl = monitorConfig.alertWebhookUrl
  const payload = {
    service: "moemail",
    summary,
    details,
    timestamp: new Date().toISOString(),
  }

  if (!alertUrl) {
    console.error(JSON.stringify({ event: "operator.alert", ...payload }))
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(alertUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(monitorConfig.alertBearerToken
          ? { Authorization: `Bearer ${monitorConfig.alertBearerToken}` }
          : {}),
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Alert webhook returned HTTP ${response.status}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function nonNegativeNumber(value: string | number | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
