const allowedFetchSites = new Set(["same-origin", "none"])

/**
 * Validate a browser mutation against the public origin seen by the client.
 *
 * Reverse proxies terminate TLS before forwarding the request to Next.js, so
 * request.url can be http:// inside the container even though the browser sent
 * Origin: https://…. Host and X-Forwarded-Proto are the proxy-preserved public
 * values and avoid rejecting legitimate same-origin mutations in that setup.
 */
export function isSameOriginMutation(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase()
  if (fetchSite && !allowedFetchSites.has(fetchSite)) return false

  const origin = request.headers.get("origin")
  if (!origin) return true

  try {
    const originUrl = new URL(origin)
    if (
      !["http:", "https:"].includes(originUrl.protocol)
      || originUrl.username
      || originUrl.password
      || originUrl.pathname !== "/"
      || originUrl.search
      || originUrl.hash
    ) return false

    const requestUrl = new URL(request.url)
    const forwardedProtocolHeader = request.headers.get("x-forwarded-proto")
    const forwardedProtocol = forwardedProtocolHeader
      ?.split(",", 1)[0]
      ?.trim()
      .toLowerCase()
    if (forwardedProtocolHeader && !["http", "https"].includes(forwardedProtocol ?? "")) return false

    const protocol = forwardedProtocol ? `${forwardedProtocol}:` : requestUrl.protocol
    if (!["http:", "https:"].includes(protocol)) return false
    const host = request.headers.get("host")?.trim() || requestUrl.host
    const publicUrl = new URL(`${protocol}//${host}`)
    return originUrl.origin === publicUrl.origin
  } catch {
    return false
  }
}
