"use client"

import { useId, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Send } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { readApiErrorCode } from "@/lib/api-error-client"
import {
  MAX_OUTBOUND_RECIPIENTS,
  parseOutboundRecipients,
} from "@/lib/outbound-recipients"
import { RecipientInput } from "./recipient-input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface SendDialogProps {
  emailId: string
  fromAddress: string
  canUsePrivateDelivery: boolean
  onSendSuccess?: () => void
}

export function SendDialog({ emailId, fromAddress, canUsePrivateDelivery, onSendSuccess }: SendDialogProps) {
  const formatList = useFormatter()
  const t = useTranslations("emails.send")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [recipients, setRecipients] = useState<string[]>([])
  const [recipientDraft, setRecipientDraft] = useState("")
  const [recipientError, setRecipientError] = useState("")
  const [subject, setSubject] = useState("")
  const [content, setContent] = useState("")
  const [format, setFormat] = useState<"text" | "html">("text")
  const [privateRecipients, setPrivateRecipients] = useState(false)
  const { toast } = useToast()
  const privateRecipientsId = useId()
  const recipientPreview = useMemo(
    () => parseOutboundRecipients([...recipients, recipientDraft]),
    [recipientDraft, recipients],
  )
  const recipientCount = recipientPreview.invalid.length > 0
    ? recipients.length
    : recipientPreview.recipients.length

  const handleSend = async () => {
    if (recipientPreview.invalid.length > 0) {
      setRecipientError(t("recipientInvalid", { value: recipientPreview.invalid[0] }))
      return
    }
    if (recipientPreview.tooMany) {
      setRecipientError(t("recipientLimit", { maximum: MAX_OUTBOUND_RECIPIENTS }))
      return
    }
    if (recipientPreview.recipients.length === 0 || !subject.trim() || !content.trim()) {
      toast({
        title: tList("error"),
        description: t("requiredFields", {
          fields: formatList.list([t("to"), t("subject"), t("content")], { type: "unit" }),
        }),
        variant: "destructive"
      })
      return
    }

    setRecipients(recipientPreview.recipients)
    setRecipientDraft("")
    setRecipientError("")

    setLoading(true)
    try {
      const response = await fetch(`/api/emails/${emailId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: recipientPreview.recipients,
          subject,
          content,
          format,
          privateRecipients: privateRecipients && recipientPreview.recipients.length > 1,
        })
      })

      if (!response.ok) {
        const code = await readApiErrorCode(response, "OUTBOUND_SEND_FAILED")
        toast({
          title: tList("error"),
          description: tApi.has(code as never) ? tApi(code as never) : t("failed"),
          variant: "destructive"
        })
        return
      }

      toast({
        title: tList("success"),
        description: t("success")
      })
      setOpen(false)
      setRecipients([])
      setRecipientDraft("")
      setRecipientError("")
      setSubject("")
      setContent("")
      setFormat("text")
      setPrivateRecipients(false)
      
      onSendSuccess?.()
    
    } catch {
      toast({
        title: tList("error"),
        description: t("failed"),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <DialogTrigger asChild>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm"
                className="h-8 gap-2 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">{t("title")}</span>
              </Button>
            </TooltipTrigger>
          </DialogTrigger>
          <TooltipContent className="sm:hidden">
            <p>{t("title")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="text-sm text-muted-foreground">
            {tFormat("labelValue", { label: t("from"), value: fromAddress })}
          </div>
          <RecipientInput
            recipients={recipients}
            draft={recipientDraft}
            error={recipientError}
            disabled={loading}
            onRecipientsChange={setRecipients}
            onDraftChange={setRecipientDraft}
            onErrorChange={setRecipientError}
          />
          <p className="text-xs text-muted-foreground">
            {t("toHelp", { count: recipientCount, maximum: MAX_OUTBOUND_RECIPIENTS })}
          </p>
          {recipientCount > 1 && (
            <div className="flex min-w-0 items-start justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0 space-y-1">
                <label htmlFor={privateRecipientsId} className="block text-sm font-medium">
                  {t("privateRecipients.label")}
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {canUsePrivateDelivery
                    ? t("privateRecipients.help")
                    : t("privateRecipients.permissionRequired")}
                </p>
              </div>
              <Switch
                id={privateRecipientsId}
                checked={privateRecipients}
                onCheckedChange={setPrivateRecipients}
                disabled={!canUsePrivateDelivery}
                aria-label={t("privateRecipients.label")}
              />
            </div>
          )}
          <Input
            value={subject}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)}
            placeholder={t("subjectPlaceholder")}
          />
          <Tabs value={format} onValueChange={value => setFormat(value as "text" | "html")}>
            <TabsList className="grid w-full grid-cols-2 sm:w-64">
              <TabsTrigger value="text">{t("formats.text")}</TabsTrigger>
              <TabsTrigger value="html">{t("formats.html")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <Textarea
            value={content}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            placeholder={format === "html" ? t("htmlPlaceholder") : t("contentPlaceholder")}
            rows={6}
            spellCheck={format === "text"}
            className={format === "html" ? "font-mono text-xs" : undefined}
          />
          <p className="text-xs text-muted-foreground">
            {format === "html" ? t("htmlHelp") : t("textHelp")}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSend} disabled={loading}>
            {loading ? t("sending") : t("send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
