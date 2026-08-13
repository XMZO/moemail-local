"use client"

import { useLocaleSwitcher } from "@/hooks/use-locale-switcher"
import { Button } from "@/components/ui/button"
import { Languages } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function FloatingLanguageSwitcher() {
  const { locale, locales, switchLocale, isPending } = useLocaleSwitcher()
  const t = useTranslations("common.actions")
  const tLocales = useTranslations("common.locales")

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="bg-white dark:bg-background rounded-full shadow-lg group relative border-primary/20 hover:border-primary/40 transition-all"
            aria-label={isPending ? t("switchingLanguage") : t("switchLanguage")}
            aria-busy={isPending}
          >
            <Languages className={`h-5 w-5 text-primary transition-transform group-hover:scale-110 ${isPending ? "animate-pulse" : ""}`} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="mb-2">
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
    </div>
  )
}
