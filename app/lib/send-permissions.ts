import { and, eq, gte, sql } from "drizzle-orm"
import type { EffectiveAccessPolicy } from "./access-policies"
import { createDb } from "./db"
import { PERMISSIONS } from "./permissions"
import { emails, messages } from "./schema"
import { getUserAccessPolicy } from "./user-access"

export interface SendPermissionResult {
  canSend: boolean
  error?: string
  remainingEmails?: number
  dailyLimit?: number
}

const sendTails = new Map<string, Promise<void>>()

export async function withUserSendLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const predecessor = sendTails.get(userId) ?? Promise.resolve()
  let release = () => {}
  const turn = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = predecessor.catch(() => {}).then(() => turn)
  sendTails.set(userId, tail)

  await predecessor.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    if (sendTails.get(userId) === tail) sendTails.delete(userId)
  }
}

export async function checkSendPermission(
  userId: string,
  skipDailyLimitCheck = false,
  resolvedAccess?: EffectiveAccessPolicy,
): Promise<SendPermissionResult> {
  try {
    const access = resolvedAccess ?? await getUserAccessPolicy(userId)
    if (!access.permissions[PERMISSIONS.SEND_EMAIL]) {
      return { canSend: false, error: "您的账号没有发件权限" }
    }

    const dailyLimit = access.quotas.dailySendLimit
    if (skipDailyLimitCheck || dailyLimit === 0) {
      return { canSend: true, dailyLimit }
    }

    const now = new Date()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const result = await createDb()
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(emails, eq(messages.emailId, emails.id))
      .where(and(
        eq(emails.userId, userId),
        eq(messages.type, "sent"),
        gte(messages.receivedAt, today),
      ))
    const sentToday = Number(result[0]?.count ?? 0)
    const remainingEmails = Math.max(0, dailyLimit - sentToday)
    if (remainingEmails === 0) {
      return {
        canSend: false,
        error: `您今天已达到发件限制 (${dailyLimit} 封)，请明天再试`,
        remainingEmails: 0,
        dailyLimit,
      }
    }

    return { canSend: true, remainingEmails, dailyLimit }
  } catch (error) {
    console.error("Failed to check send permission:", error)
    return { canSend: false, error: "权限检查失败" }
  }
}
