"use client"

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Send } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { readApiErrorCode } from "@/lib/api-error-client"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface SendDialogProps {
  emailId: string
  fromAddress: string
  onSendSuccess?: () => void
}

export function SendDialog({ emailId, fromAddress, onSendSuccess }: SendDialogProps) {
  const formatList = useFormatter()
  const t = useTranslations("emails.send")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [to, setTo] = useState("")
  const [subject, setSubject] = useState("")
  const [content, setContent] = useState("")
  const [format, setFormat] = useState<"text" | "html">("text")
  const { toast } = useToast()

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !content.trim()) {
      toast({
        title: tList("error"),
        description: t("requiredFields", {
          fields: formatList.list([t("to"), t("subject"), t("content")], { type: "unit" }),
        }),
        variant: "destructive"
      })
      return
    }

    setLoading(true)
    try {
      const response = await fetch(`/api/emails/${emailId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, content, format })
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
      setTo("")
      setSubject("")
      setContent("")
      setFormat("text")
      
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="text-sm text-muted-foreground">
            {tFormat("labelValue", { label: t("from"), value: fromAddress })}
          </div>
          <Input
            value={to}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
            placeholder={t("toPlaceholder")}
          />
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
