"use client"

import { ShieldAlert } from "lucide-react"
import Link from "next/link"
import { useLocale, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"

export function AuthErrorContent() {
  const locale = useLocale()
  const t = useTranslations("auth.authError")

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 px-4 py-20 dark:from-gray-900 dark:to-gray-800">
      <section className="w-full max-w-md rounded-xl border-2 border-primary/20 bg-background p-6 text-center shadow-sm sm:p-8">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("description")}</p>
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          <Button asChild><Link href={`/${locale}/login`}>{t("retry")}</Link></Button>
          <Button asChild variant="outline"><Link href={`/${locale}`}>{t("home")}</Link></Button>
        </div>
      </section>
    </main>
  )
}
