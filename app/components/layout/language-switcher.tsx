"use client"

import { useLocaleSwitcher } from "@/hooks/use-locale-switcher"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Languages } from "lucide-react"
import { useTranslations } from "next-intl"

export function LanguageSwitcher() {
  const { locale, locales, switchLocale, isPending } = useLocaleSwitcher()
  const t = useTranslations("common.actions")
  const tLocales = useTranslations("common.locales")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={isPending ? t("switchingLanguage") : t("switchLanguage")} aria-busy={isPending}>
          <Languages className={`h-5 w-5 ${isPending ? "animate-pulse" : ""}`} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {locales.map((loc) => (
          <DropdownMenuItem
            key={loc}
            onClick={() => switchLocale(loc)}
            disabled={isPending}
            className={locale === loc ? "bg-accent" : ""}
          >
            {tLocales(loc)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
