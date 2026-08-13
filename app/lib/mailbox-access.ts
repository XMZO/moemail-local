import { and, eq, gt } from "drizzle-orm"
import { createDb } from "./db"
import { emails } from "./schema"

/**
 * Active-use boundary for mailbox APIs. Listing already hides expired
 * mailboxes; direct ID-based routes must enforce the same invariant so an old
 * URL or API key cannot keep using a mailbox after its configured lifetime.
 */
export function findOwnedActiveMailbox(userId: string, mailboxId: string) {
  return createDb().query.emails.findFirst({
    where: and(
      eq(emails.id, mailboxId),
      eq(emails.userId, userId),
      gt(emails.expiresAt, new Date()),
    ),
  })
}

export async function ownedMailboxState(userId: string, mailboxId: string) {
  const mailbox = await createDb().query.emails.findFirst({
    where: eq(emails.id, mailboxId),
    columns: { userId: true, expiresAt: true },
  })
  if (!mailbox) return "not_found" as const
  if (mailbox.userId !== userId) return "forbidden" as const
  if (mailbox.expiresAt.getTime() <= Date.now()) return "expired" as const
  return "active" as const
}
