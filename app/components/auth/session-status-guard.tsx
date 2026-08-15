"use client"

import { useCallback, useEffect, useRef } from "react"
import { signOut, useSession } from "next-auth/react"
import { useTranslations } from "next-intl"
import { toast } from "@/components/ui/use-toast"
import {
  announceBannedApiResponse,
  USER_BANNED_EVENT,
} from "@/lib/api-error-client"

const BANNED_NOTICE_KEY = "moemail:banned-session-notice"

/** Revokes stale browser sessions as soon as the server reports a ban. */
export function SessionStatusGuard() {
  const { data: session } = useSession()
  const tApi = useTranslations("api")
  const terminating = useRef(false)

  const terminateSession = useCallback(async () => {
    if (terminating.current) return
    terminating.current = true
    try {
      sessionStorage.setItem(BANNED_NOTICE_KEY, "1")
    } catch {
      // Navigation and sign-out still work when sessionStorage is unavailable.
    }

    try {
      await signOut({ redirect: false })
    } catch (error) {
      console.error("auth.banned_session_sign_out_failed", error)
    } finally {
      window.location.replace(new URL("/", window.location.origin).href)
    }
  }, [])

  useEffect(() => {
    try {
      if (sessionStorage.getItem(BANNED_NOTICE_KEY) !== "1") return
      sessionStorage.removeItem(BANNED_NOTICE_KEY)
      toast({
        title: tApi("USER_BANNED"),
        variant: "destructive",
        duration: 5_000,
      })
    } catch {
      // A blocked storage API must not prevent rendering the public homepage.
    }
  }, [tApi])

  useEffect(() => {
    if (session?.user?.bannedAt) void terminateSession()
  }, [session?.user?.bannedAt, terminateSession])

  useEffect(() => {
    const onBanned = () => void terminateSession()
    window.addEventListener(USER_BANNED_EVENT, onBanned)
    return () => window.removeEventListener(USER_BANNED_EVENT, onBanned)
  }, [terminateSession])

  useEffect(() => {
    const previousFetch = window.fetch
    const guardedFetch: typeof window.fetch = async (...args) => {
      const response = await previousFetch(...args)
      void announceBannedApiResponse(response)
      return response
    }
    window.fetch = guardedFetch
    return () => {
      if (window.fetch === guardedFetch) window.fetch = previousFetch
    }
  }, [])

  return null
}
