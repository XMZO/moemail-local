import { i18n, type Locale } from "./config"

export function localizedHref(
  pathname: string,
  search: string,
  hash: string,
  locale: Locale,
) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`
  const segments = normalizedPath.split("/")
  if (i18n.locales.includes(segments[1] as Locale)) {
    segments[1] = locale
  } else {
    segments.splice(1, 0, locale)
  }

  const localizedPath = segments.join("/").replace(/\/$/u, "") || `/${locale}`
  const normalizedSearch = search && !search.startsWith("?") ? `?${search}` : search
  const normalizedHash = hash && !hash.startsWith("#") ? `#${hash}` : hash
  return `${localizedPath}${normalizedSearch}${normalizedHash}`
}
