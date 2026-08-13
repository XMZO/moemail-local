"use client"

import { useState, useEffect } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Loader2, Share2 } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { ShareMessageDialog } from "./share-message-dialog"
import { useRolePermission } from "@/hooks/use-role-permission"
import { PERMISSIONS } from "@/lib/permissions"
import { HtmlMessageFrame } from "./html-message-frame"

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  content: string
  html?: string
  received_at?: number
  sent_at?: number
}

interface MessageViewProps {
  emailId: string
  messageId: string
  messageType?: 'received' | 'sent'
  onClose: () => void
}

type ViewMode = "html" | "text"

export function MessageView({ emailId, messageId, messageType = 'received' }: MessageViewProps) {
  const format = useFormatter()
  const t = useTranslations("emails.messageView")
  const tMessages = useTranslations("emails.messages")
  const tList = useTranslations("emails.list")
  const tFormat = useTranslations("common.format")
  const { checkPermission } = useRolePermission()
  const canShare = checkPermission(PERMISSIONS.SHARE_EMAIL)
  const [message, setMessage] = useState<Message | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("html")
  const { toast } = useToast()

  useEffect(() => {
    const fetchMessage = async () => {
      try {
        setLoading(true)
        setError(null)
        
        const url = `/api/emails/${emailId}/${messageId}${messageType === 'sent' ? '?type=sent' : ''}`;
        
        const response = await fetch(url)
        
        if (!response.ok) {
          const errorMessage = t("loadError")
          setError(errorMessage)
          toast({
            title: tList("error"),
            description: errorMessage,
            variant: "destructive"
          })
          return
        }
        
        const data = await response.json() as { message: Message }
        setMessage(data.message)
        if (!data.message.html) {
          setViewMode("text")
        }
      } catch (error) {
        const errorMessage = t("networkError")
        setError(errorMessage)
        toast({
          title: tList("error"), 
          description: errorMessage,
          variant: "destructive"
        })
        console.error("message.detail_fetch_failed", error)
      } finally {
        setLoading(false)
      }
    }

    fetchMessage()
  }, [emailId, messageId, messageType, toast, t, tList])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-primary/60" />
        <span className="ml-2 text-sm text-gray-500">{t("loading")}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-center">
        <p className="text-sm text-destructive mb-2">{error}</p>
        <button 
          onClick={() => window.location.reload()} 
          className="text-xs text-primary hover:underline"
        >
          {t("retry")}
        </button>
      </div>
    )
  }

  if (!message) return null

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 space-y-3 border-b border-primary/20">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-bold flex-1">{message.subject || tMessages("noSubject")}</h3>
          {canShare && <ShareMessageDialog
            emailId={emailId}
            messageId={message.id}
            messageSubject={message.subject || tMessages("noSubject")}
            trigger={
              <button className="p-1.5 hover:bg-primary/10 rounded-md transition-colors">
                <Share2 className="h-4 w-4 text-gray-500" />
              </button>
            }
          />}
        </div>
        <div className="text-xs text-gray-500 space-y-1">
          {message.from_address && (
            <p>{tFormat("labelValue", { label: t("from"), value: message.from_address })}</p>
          )}
          {message.to_address && (
            <p>{tFormat("labelValue", { label: t("to"), value: message.to_address })}</p>
          )}
          <p>{tFormat("labelValue", {
            label: t("time"),
            value: format.dateTime(new Date(message.sent_at || message.received_at || 0)),
          })}</p>
        </div>
      </div>
      
      {message.html && message.content && (
        <div className="border-b border-primary/20 p-2">
          <RadioGroup
            value={viewMode}
            onValueChange={(value) => setViewMode(value as ViewMode)}
            className="flex items-center gap-4"
          >
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="html" id="html" />
              <Label
                htmlFor="html"
                className="text-xs cursor-pointer"
              >
                {t("htmlFormat")}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="text" id="text" />
              <Label
                htmlFor="text"
                className="text-xs cursor-pointer"
              >
                {t("textFormat")}
              </Label>
            </div>
          </RadioGroup>
        </div>
      )}
      
      <div className="flex-1 overflow-auto relative">
        {viewMode === "html" && message.html ? (
          <HtmlMessageFrame html={message.html} title={t("htmlFormat")} />
        ) : (
          <div className="p-4 text-sm whitespace-pre-wrap">
            {message.content}
          </div>
        )}
      </div>
    </div>
  )
}
