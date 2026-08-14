"use client"

import { useCallback, useState, useEffect } from "react"
import { useTranslations } from "next-intl"

interface SendPermissionResponse {
  canSend: boolean
  error?: string
  remainingEmails?: number
  canUsePrivateRecipientDelivery?: boolean
}

export function useSendPermission(emailId?: string) {
  const t = useTranslations("emails.send")
  const tApi = useTranslations("api")
  const [canSend, setCanSend] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remainingEmails, setRemainingEmails] = useState<number | undefined>()
  const [canUsePrivateRecipientDelivery, setCanUsePrivateRecipientDelivery] = useState(false)

  const checkPermission = useCallback(async () => {
    if (!emailId) {
      setCanSend(false)
      setRemainingEmails(undefined)
      setCanUsePrivateRecipientDelivery(false)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`/api/emails/send-permission?emailId=${encodeURIComponent(emailId)}`)
      
      if (!response.ok) {
        setCanSend(false)
        setCanUsePrivateRecipientDelivery(false)
        setError(t("permissionCheckFailed"))
        return
      }

      const data = await response.json() as SendPermissionResponse
      setCanSend(data.canSend)
      setRemainingEmails(data.remainingEmails)
      setCanUsePrivateRecipientDelivery(Boolean(data.canUsePrivateRecipientDelivery))
      
      setError(data.canSend ? null : tApi.has(data.error as never)
        ? tApi(data.error as never)
        : t("permissionDenied"))
    } catch {
      setCanSend(false)
      setCanUsePrivateRecipientDelivery(false)
      setError(t("permissionCheckFailed"))
    } finally {
      setLoading(false)
    }
  }, [emailId, t, tApi])

  useEffect(() => {
    void checkPermission()
  }, [checkPermission])

  return {
    canSend,
    loading,
    error,
    remainingEmails,
    canUsePrivateRecipientDelivery,
    checkPermission
  }
}
