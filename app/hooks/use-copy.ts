"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { useToast } from "@/components/ui/use-toast"

interface UseCopyOptions {
  successMessage?: string
  errorMessage?: string
}

export function useCopy(options: UseCopyOptions = {}) {
  const { toast } = useToast()
  const t = useTranslations("common.feedback")
  const {
    successMessage = t("copied"),
    errorMessage = t("copyFailed")
  } = options

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({
        title: t("success"),
        description: successMessage
      })
      return true
    } catch {
      toast({
        title: t("error"),
        description: errorMessage,
        variant: "destructive"
      })
      return false
    }
  }, [successMessage, errorMessage, t, toast])

  return {
    copyToClipboard
  }
}
