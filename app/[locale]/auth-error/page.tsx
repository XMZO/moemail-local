import { AuthErrorContent } from "@/components/auth/auth-error-content"
import type { Locale } from "@/i18n/config"
import { requireCompletedSetup } from "@/lib/setup-navigation"

export const runtime = "nodejs"

export default async function AuthErrorPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  requireCompletedSetup(locale)
  return <AuthErrorContent />
}
