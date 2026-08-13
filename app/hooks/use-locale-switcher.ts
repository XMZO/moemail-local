"use client"

import { i18n } from "@/i18n/config"
import { useInstantLocale } from "@/i18n/locale-provider"

export function useLocaleSwitcher() {
  const { locale, switching, switchLocale } = useInstantLocale()

  return {
    locale,
    switchLocale,
    locales: i18n.locales,
    isPending: switching,
  }
}

