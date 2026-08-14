"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { flushSync } from "react-dom"
import { NextIntlClientProvider } from "next-intl"
import type { Locale } from "./config"
import type { AppMessages } from "./messages"
import { localizedHref } from "./navigation"

type LocaleCatalogs = Record<Locale, AppMessages>

interface LocaleContextValue {
  locale: Locale
  switching: boolean
  switchLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

export function InstantLocaleProvider({
  initialLocale,
  catalogs,
  children,
}: {
  initialLocale: Locale
  catalogs: LocaleCatalogs
  children: React.ReactNode
}) {
  const [locale, setLocale] = useState(initialLocale)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    const canonicalHref = localizedHref(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    )
    const visibleHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (canonicalHref !== visibleHref) {
      window.history.replaceState(window.history.state, "", canonicalHref)
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
    const metadata = catalogs[locale].metadata as { title?: unknown }
    if (typeof metadata.title === "string") document.title = metadata.title
  }, [catalogs, locale])

  const switchLocale = useCallback((nextLocale: Locale) => {
    if (nextLocale === locale || switching) return

    const commit = () => {
      document.cookie = `NEXT_LOCALE=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`
      const target = localizedHref(
        window.location.pathname,
        window.location.search,
        window.location.hash,
      )
      flushSync(() => setLocale(nextLocale))
      window.history.replaceState(window.history.state, "", target)
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const transitionDocument = document as ViewTransitionDocument
    if (!reduceMotion && transitionDocument.startViewTransition) {
      setSwitching(true)
      transitionDocument.startViewTransition(commit).finished.finally(() => setSwitching(false))
      return
    }

    if (!reduceMotion) {
      setSwitching(true)
      document.documentElement.dataset.localeTransition = "entering"
    }
    commit()
    if (!reduceMotion) {
      window.setTimeout(() => {
        delete document.documentElement.dataset.localeTransition
        setSwitching(false)
      }, 180)
    }
  }, [locale, switching])

  const value = useMemo(() => ({ locale, switching, switchLocale }), [locale, switching, switchLocale])
  return (
    <LocaleContext.Provider value={value}>
      <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  )
}

export function useInstantLocale() {
  const value = useContext(LocaleContext)
  if (!value) throw new Error()
  return value
}
