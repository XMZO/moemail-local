import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { i18n, type Locale } from "@/i18n/config"
import { emptyMessages, loadMessages } from "@/i18n/messages"
import { InstantLocaleProvider } from "@/i18n/locale-provider"
import type { CSSProperties } from "react"
import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { FloatMenu } from "@/components/float-menu"
import { CustomAppearanceInjector } from "@/components/custom-appearance-injector"
import { ThemeProvider } from "@/components/theme/theme-provider"
import { Toaster } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import { zpix } from "../fonts"
import "../globals.css"
import { Providers } from "../providers"
import {
  getConfigStatus,
  getPublicRuntimeConfig,
} from "@/lib/config/runtime"
import { DEFAULT_PUBLIC_RUNTIME_CONFIG } from "@/lib/config/public"
import { DEFAULT_APPEARANCE_CONFIG } from "@/lib/appearance-values"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const viewport: Viewport = {
  themeColor: '#826DD9',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

async function getMessages(locale: Locale) {
  try {
    return await loadMessages(locale)
  } catch (error) {
    console.error("i18n.catalog_load_failed", { locale, error })
    return emptyMessages()
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  const t = await getTranslations({ locale, namespace: "metadata" })

  let baseUrl = DEFAULT_PUBLIC_RUNTIME_CONFIG.baseUrl
  try {
    baseUrl = getPublicRuntimeConfig().baseUrl
  } catch {
    // 初始化前或配置文件损坏且没有 LKG 时使用安全的展示默认值。
  }
  
  return {
    title: t("title"),
    description: t("description"),
    keywords: t("keywords"),
    authors: [{ name: "SoftMoe Studio" }],
    creator: "SoftMoe Studio",
    publisher: "SoftMoe Studio",
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
      },
    },
    openGraph: {
      type: "website",
      locale: locale === "zh-CN" ? "zh_CN" : locale === "zh-TW" ? "zh_TW" : locale,
      url: baseUrl,
      title: t("title"),
      description: t("description"),
      siteName: "MoeMail",
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("description"),
    },
    alternates: {
      canonical: baseUrl,
    },
    manifest: '/manifest.json',
    icons: [
      { rel: 'apple-touch-icon', url: '/icons/icon-192x192.png' },
    ],
  }
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale: localeFromParams } = await params
  const locale = localeFromParams as Locale
  if (!i18n.locales.includes(locale)) {
    notFound()
  }

  const catalogs = Object.fromEntries(await Promise.all(i18n.locales.map(async catalogLocale => (
    [catalogLocale, await getMessages(catalogLocale)] as const
  )))) as Record<Locale, Awaited<ReturnType<typeof getMessages>>>
  const configStatus = getConfigStatus()
  let runtimeConfig = DEFAULT_PUBLIC_RUNTIME_CONFIG
  let appearance = DEFAULT_APPEARANCE_CONFIG
  const safeAppearance = (await headers()).get("x-moemail-safe-appearance") === "1"
  try {
    runtimeConfig = getPublicRuntimeConfig()
    if (configStatus.setupCompleted) {
      const { getAppearanceConfig } = await import("@/lib/appearance")
      appearance = await getAppearanceConfig()
    }
  } catch {
    // 初始化向导仍应可渲染，不能被坏配置挡在 WebUI 外。
  }

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="application-name" content="MoeMail" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="MoeMail" />
        <meta name="format-detection" content="telephone=no" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body 
        style={{
          "--moemail-ui-font-family": appearance.fontFamily,
          fontFamily: "var(--moemail-ui-font-family)",
        } as CSSProperties}
        className={cn(
          zpix.variable,
          "font-zpix min-h-screen antialiased",
          "bg-background text-foreground",
          "transition-colors duration-300"
        )}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange={false}
          storageKey="temp-mail-theme"
        >
          <Providers
            runtimeConfig={runtimeConfig}
            sessionEnabled={configStatus.setupCompleted}
            runtimeRefreshEnabled={configStatus.setupCompleted}
          >
            <InstantLocaleProvider initialLocale={locale} catalogs={catalogs}>
              {children}
              <FloatMenu />
            </InstantLocaleProvider>
          </Providers>
          <Toaster />
          {appearance.advancedEnabled && !safeAppearance && <CustomAppearanceInjector
            customCss={appearance.customCss}
            headHtml={appearance.headHtml}
            bodyEndHtml={appearance.bodyEndHtml}
            customJs={appearance.customJs}
            customJsEnabled={appearance.customJsEnabled}
          />}
        </ThemeProvider>
      </body>
    </html>
  )
}

