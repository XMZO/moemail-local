import { SharedErrorPage } from "@/components/emails/shared-error-page"
import { SharedEmailPageClient } from "./page-client"
import { requireCompletedSetup } from "@/lib/setup-navigation"

interface PageProps {
  params: Promise<{
    token: string
    locale: string
  }>
}

export default async function SharedEmailPage({ params }: PageProps) {
  const { token, locale } = await params
  requireCompletedSetup(locale)
  const { getSharedEmail, getSharedEmailMessages } = await import("@/lib/shared-data")

  // 服务端获取数据
  const email = await getSharedEmail(token)

  if (!email) {
    return (
      <SharedErrorPage
        titleKey="emailNotFound"
        subtitleKey="linkExpired"
        errorKey="linkInvalid"
        descriptionKey="linkInvalidDescription"
        ctaTextKey="createOwnEmail"
      />
    )
  }

  // 获取初始消息列表
  const messagesResult = await getSharedEmailMessages(token)

  return (
    <SharedEmailPageClient
      email={email}
      initialMessages={messagesResult.messages}
      initialNextCursor={messagesResult.nextCursor}
      initialTotal={messagesResult.total}
      token={token}
    />
  )
}
