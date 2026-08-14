"use client"

import { useState, useEffect } from "react"
import { Loader2 } from "lucide-react"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { useFormatter, useTranslations } from "next-intl"
import { HtmlMessageFrame } from "./html-message-frame"

interface MessageDetail {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  content?: string
  html?: string
  received_at?: number
  sent_at?: number
}

interface SharedMessageDetailProps {
  message: MessageDetail | null
  loading?: boolean
  t: {
    messageContent: string
    selectMessage: string
    loading: string
    from: string
    to: string
    subject: string
    time: string
    htmlFormat: string
    textFormat: string
    noSubject: string
  }
}

type ViewMode = "html" | "text"

export function SharedMessageDetail({
  message,
  loading = false,
  t,
}: SharedMessageDetailProps) {
  const format = useFormatter()
  const tCommon = useTranslations("common")
  const [viewMode, setViewMode] = useState<ViewMode>("html")

  // 如果没有HTML内容，默认显示文本
  useEffect(() => {
    if (message) {
      if (!message.html && message.content) {
        setViewMode("text")
      } else if (message.html) {
        setViewMode("html")
      }
    }
  }, [message])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-primary/60" />
        <span className="ml-2 text-sm text-gray-500">{t.loading}</span>
      </div>
    )
  }

  if (!message) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-500">
        {t.selectMessage}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-4 space-y-3 border-b border-primary/20">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-bold flex-1">{message.subject || t.noSubject}</h3>
        </div>
        <div className="text-xs text-gray-500 space-y-1">
          {message.from_address && (
            <p>
              {tCommon("format.labelValue", { label: t.from, value: message.from_address })}
            </p>
          )}
          {message.to_address && (
            <p>
              {tCommon("format.labelValue", { label: t.to, value: message.to_address })}
            </p>
          )}
          <p>
            {tCommon("format.labelValue", {
              label: t.time,
              value: format.dateTime(new Date(message.sent_at || message.received_at || 0)),
            })}
          </p>
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
              <Label htmlFor="html" className="text-xs cursor-pointer">
                {t.htmlFormat}
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="text" id="text" />
              <Label htmlFor="text" className="text-xs cursor-pointer">
                {t.textFormat}
              </Label>
            </div>
          </RadioGroup>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto">
        {viewMode === "html" && message.html ? (
          <HtmlMessageFrame html={message.html} title={t.htmlFormat} />
        ) : message.content ? (
          <div className="p-4 text-sm whitespace-pre-wrap">
            {message.content}
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
            {t.selectMessage}
          </div>
        )}
      </div>
    </div>
  )
}
