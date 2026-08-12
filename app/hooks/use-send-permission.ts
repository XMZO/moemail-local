import { useCallback, useState, useEffect } from 'react'

interface SendPermissionResponse {
  canSend: boolean
  error?: string
  remainingEmails?: number
}

export function useSendPermission(emailId?: string) {
  const [canSend, setCanSend] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remainingEmails, setRemainingEmails] = useState<number | undefined>()

  const checkPermission = useCallback(async () => {
    if (!emailId) {
      setCanSend(false)
      setRemainingEmails(undefined)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`/api/emails/send-permission?emailId=${encodeURIComponent(emailId)}`)
      
      if (!response.ok) {
        throw new Error('权限检查失败')
      }

      const data = await response.json() as SendPermissionResponse
      setCanSend(data.canSend)
      setRemainingEmails(data.remainingEmails)
      
      if (!data.canSend && data.error) {
        setError(data.error)
      }
    } catch (err) {
      setCanSend(false)
      setError(err instanceof Error ? err.message : '权限检查失败')
    } finally {
      setLoading(false)
    }
  }, [emailId])

  useEffect(() => {
    void checkPermission()
  }, [checkPermission])

  return {
    canSend,
    loading,
    error,
    remainingEmails,
    checkPermission
  }
}
