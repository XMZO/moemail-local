import { NextRequest, NextResponse } from "next/server"
import { i18n, type Locale } from "@/i18n/config"

const localeCookie = "NEXT_LOCALE"
const localeCookieMaxAge = 365 * 24 * 60 * 60
const internalLocaleRewriteHeader = "x-moemail-internal-locale-rewrite"

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone()
  const pathname = url.pathname

  if (pathname.startsWith('/api')) {
    return NextResponse.next()
  }

  const segments = pathname.split('/')
  const maybeLocale = segments[1]
  const prefixedLocale = i18n.locales.includes(maybeLocale as Locale)
    ? maybeLocale as Locale
    : null

  const requestHeaders = new Headers(request.headers)
  if (url.searchParams.get("safe-appearance") === "1") {
    requestHeaders.set("x-moemail-safe-appearance", "1")
  } else {
    requestHeaders.delete("x-moemail-safe-appearance")
  }

  // Next.js may run middleware again for the internal rewrite. Only this
  // marked pass may keep the internal /[locale] route without canonicalizing it.
  if (prefixedLocale && request.headers.get(internalLocaleRewriteHeader) === "1") {
    requestHeaders.delete(internalLocaleRewriteHeader)
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.headers.set('Content-Language', prefixedLocale)
    response.headers.set('Vary', 'Cookie, Accept-Language')
    return response
  }

  // 旧的带语言前缀链接仍然直接渲染，并通过 Cookie 保留链接明确
  // 指定的语言。客户端在水合时原地清理地址栏，避免任何 Host 重定向。
  if (prefixedLocale) {
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.cookies.set(localeCookie, prefixedLocale, {
      maxAge: localeCookieMaxAge,
      path: '/',
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
    })
    response.headers.set('Content-Language', prefixedLocale)
    response.headers.set('Vary', 'Cookie, Accept-Language')
    return response
  }

  const cookieLocale = request.cookies.get(localeCookie)?.value
  const preferredLocale = resolvePreferredLocale(
    cookieLocale,
    request.headers.get('Accept-Language'),
  )
  const targetLocale = preferredLocale ?? i18n.defaultLocale
  const rewriteUrl = request.nextUrl.clone()
  rewriteUrl.pathname = pathname === '/' ? `/${targetLocale}` : `/${targetLocale}${pathname}`
  requestHeaders.set(internalLocaleRewriteHeader, "1")

  const response = NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } })
  response.headers.set('Content-Language', targetLocale)
  response.headers.set('Vary', 'Cookie, Accept-Language')
  return response
}

function resolvePreferredLocale(cookieLocale: string | undefined, acceptLanguageHeader: string | null): Locale | null {
  if (cookieLocale && i18n.locales.includes(cookieLocale as Locale)) {
    return cookieLocale as Locale
  }

  if (!acceptLanguageHeader) return null

  const candidates = parseAcceptLanguage(acceptLanguageHeader)
  for (const lang of candidates) {
    const match = matchLocale(lang)
    if (match) {
      return match
    }
  }

  return null
}

function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [lang, ...params] = part.trim().split(';')
      const qualityParam = params.find((param) => param.trim().startsWith('q='))
      const quality = qualityParam ? parseFloat(qualityParam.split('=')[1]) : 1
      return { lang: lang.toLowerCase(), quality: isNaN(quality) ? 1 : quality }
    })
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.lang)
}

function matchLocale(lang: string): Locale | null {
  const exactMatch = i18n.locales.find((locale) => locale.toLowerCase() === lang)
  if (exactMatch) return exactMatch

  const base = lang.split('-')[0]

  // Handle Chinese variants with explicit regions or scripts
  if (base === 'zh') {
    if (lang.includes('tw') || lang.includes('hk') || lang.includes('mo') || lang.includes('hant')) {
      return 'zh-TW'
    }
    if (lang.includes('cn') || lang.includes('sg') || lang.includes('hans')) {
      return 'zh-CN'
    }
    // default Chinese fallback
    return 'zh-CN'
  }

  const baseMatch = i18n.locales.find((locale) => locale.toLowerCase().split('-')[0] === base)
  if (baseMatch) return baseMatch

  return null
}

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)', // all pages excluding static assets
  ]
} 
