import { i18n, type Locale } from "./config"

export function localizedHref(
  pathname: string,
  search: string,
  hash: string,
) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`
  const segments = normalizedPath.split("/")
  if (i18n.locales.includes(segments[1] as Locale)) {
    segments.splice(1, 1)
  }

  const localizedPath = segments.join("/").replace(/\/$/u, "") || "/"
  const normalizedSearch = search && !search.startsWith("?") ? `?${search}` : search
  const normalizedHash = hash && !hash.startsWith("#") ? `#${hash}` : hash
  return `${localizedPath}${normalizedSearch}${normalizedHash}`
}
