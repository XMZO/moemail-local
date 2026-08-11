import { sql } from "drizzle-orm"
import { getConfigStatus } from "@/lib/config/runtime"
import { createDb, getDatabaseDriver } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const noStore = { "Cache-Control": "no-store" }

export async function GET() {
  const status = getConfigStatus()

  if (status.fatal) {
    return Response.json({
      // Web 进程仍可提供修复向导；Docker/systemd 不应因候选配置损坏
      // 把唯一的恢复入口永久挡在 unhealthy dependency 后面。
      // 此接口匿名可达，不能返回可能含密钥或本机路径的解析详情。
      status: "config-recovery-required",
      reason: "config-invalid",
    }, { headers: noStore })
  }

  // 初始化向导尚未完成：进程是健康的，只是还没有数据库可用。
  if (!status.setupCompleted) {
    return Response.json({
      status: "setup-required",
    }, { headers: noStore })
  }

  try {
    await createDb().select({ ok: sql<number>`1` })
    return Response.json({
      status: "ok",
      database: getDatabaseDriver(),
      configRevision: status.revision,
      restartRequired: status.restartRequired?.reason ?? null,
      configError: status.lastError ? "invalid-change-rejected" : null,
    }, { headers: noStore })
  } catch (error) {
    console.error("Health check failed", error)
    return Response.json({ status: "unhealthy", reason: "database" }, {
      status: 503,
      headers: noStore,
    })
  }
}
