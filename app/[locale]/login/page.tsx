import { LoginForm } from "@/components/auth/login-form"
import { redirect } from "next/navigation"
import type { Locale } from "@/i18n/config"
import { requireCompletedSetup } from "@/lib/setup-navigation"

export const runtime = "nodejs"

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  requireCompletedSetup(locale)
  const { auth } = await import("@/lib/auth")
  const { getTurnstileConfig } = await import("@/lib/turnstile")
  const session = await auth()
  
  if (session?.user) {
    redirect(`/${locale}`)
  }

  const turnstile = await getTurnstileConfig()

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 px-4 py-6 dark:from-gray-900 dark:to-gray-800 sm:py-10">
      <LoginForm turnstile={{ enabled: turnstile.enabled, siteKey: turnstile.siteKey }} />
    </div>
  )
}
