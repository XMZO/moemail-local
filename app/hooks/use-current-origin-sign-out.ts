"use client"

import { useCallback, useRef, useState } from "react"
import { signOut } from "next-auth/react"

/**
 * Auth.js resolves relative callback URLs against the host seen by the server.
 * Behind a reverse proxy that host can be an internal listener such as
 * 0.0.0.0:3000, so navigation must remain a browser-side responsibility.
 */
export function useCurrentOriginSignOut(locale: string) {
  const inFlight = useRef(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  const signOutFromCurrentOrigin = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setIsSigningOut(true)

    try {
      await signOut({ redirect: false })
      const localizedHome = new URL(`/${locale}`, window.location.origin)
      window.location.replace(localizedHome.href)
    } catch (error) {
      inFlight.current = false
      setIsSigningOut(false)
      console.error("auth.sign_out_failed", error)
    }
  }, [locale])

  return { isSigningOut, signOutFromCurrentOrigin }
}
