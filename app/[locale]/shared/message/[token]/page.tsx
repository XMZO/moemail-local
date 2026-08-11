import { SharedErrorPage } from "@/components/emails/shared-error-page"
import { SharedMessagePageClient } from "./page-client"
import { requireCompletedSetup } from "@/lib/setup-navigation"

interface PageProps {
  params: Promise<{
    token: string
    locale: string
  }>
}

export default async function SharedMessagePage({ params }: PageProps) {
  const { token, locale } = await params
  requireCompletedSetup(locale)
  const { getSharedMessage } = await import("@/lib/shared-data")
  
  // 服务端获取数据
  const message = await getSharedMessage(token)
  
  if (!message) {
    return (
      <SharedErrorPage
        titleKey="messageNotFound"
        subtitleKey="linkExpired"
        errorKey="linkInvalid"
        descriptionKey="linkInvalidDescription"
        ctaTextKey="createOwnEmail"
      />
    )
  }

  return <SharedMessagePageClient message={message} />
}
