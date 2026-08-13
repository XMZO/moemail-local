"use client"

import { Clock, Code2, Shield, Share2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { ActionButton } from "./action-button"
import { FeatureCard } from "./feature-card"

export function HomeContent({ isLoggedIn }: { isLoggedIn: boolean }) {
  const t = useTranslations("home")

  return (
    <main className="pt-16">
      <div className="relative flex h-[calc(100vh-4rem)] flex-col items-center justify-center overflow-hidden px-2 text-center">
        <div className="absolute inset-0 -z-10 bg-grid-primary/5" />
        <div className="mx-auto w-full max-w-3xl space-y-6 py-4 sm:space-y-8">
          <div className="space-y-2 sm:space-y-3">
            <h1 className="text-3xl font-bold tracking-wider sm:text-4xl md:text-5xl">
              <span className="bg-gradient-to-r from-primary to-purple-600 bg-clip-text text-transparent">
                {t("title")}
              </span>
            </h1>
            <p className="text-lg tracking-wide text-gray-600 dark:text-gray-300 sm:text-xl">
              {t("subtitle")}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 px-2 sm:grid-cols-2 sm:gap-4 sm:px-0">
            <FeatureCard
              icon={<Shield className="h-5 w-5" />}
              title={t("features.privacy.title")}
              description={t("features.privacy.description")}
            />
            <FeatureCard
              icon={<Share2 className="h-5 w-5" />}
              title={t("features.instant.title")}
              description={t("features.instant.description")}
            />
            <FeatureCard
              icon={<Clock className="h-5 w-5" />}
              title={t("features.expiry.title")}
              description={t("features.expiry.description")}
            />
            <FeatureCard
              icon={<Code2 className="h-5 w-5" />}
              title={t("features.openapi.title")}
              description={t("features.openapi.description")}
            />
          </div>

          <div className="flex flex-col items-center justify-center gap-3 px-2 sm:flex-row sm:gap-4 sm:px-0">
            <ActionButton isLoggedIn={isLoggedIn} />
          </div>
        </div>
      </div>
    </main>
  )
}
