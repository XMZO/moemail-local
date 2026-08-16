"use client"

import { useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Copy, Plus, RefreshCw, TriangleAlert } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { nanoid } from "nanoid"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { EXPIRY_OPTIONS } from "@/types/email"
import { useCopy } from "@/hooks/use-copy"
import { useConfig } from "@/hooks/use-config"
import { readApiErrorCode } from "@/lib/api-error-client"
import { normalizeMailboxCreationName } from "@/lib/email-address"

interface CreateDialogProps {
  onEmailCreated: () => void
}

export function CreateDialog({ onEmailCreated }: CreateDialogProps) {
  const { config, fetch: refreshConfig } = useConfig()
  const t = useTranslations("emails.create")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [emailName, setEmailName] = useState("")
  const [discardedDomain, setDiscardedDomain] = useState(false)
  const [currentDomain, setCurrentDomain] = useState("")
  const [expiryTime, setExpiryTime] = useState(EXPIRY_OPTIONS[1].value.toString())
  const usageWarningDescriptionId = useId()
  const { toast } = useToast()
  const { copyToClipboard } = useCopy()

  const normalizedEmailName = normalizeMailboxCreationName(emailName) ?? ""
  const invalidEmailName = emailName.length > 0 && !normalizedEmailName
  const selectedDomain = config?.domains.find(option => option.domain === currentDomain)

  const generateRandomName = () => {
    setEmailName(nanoid(8))
    setDiscardedDomain(false)
  }

  const copyEmailAddress = () => {
    if (normalizedEmailName && currentDomain) {
      copyToClipboard(`${normalizedEmailName}@${currentDomain}`)
    }
  }

  const createEmail = async () => {
    if (!currentDomain) {
      toast({
        title: tList("error"),
        description: t("noAvailableDomains"),
        variant: "destructive",
      })
      return
    }
    if (invalidEmailName) {
      toast({
        title: tList("error"),
        description: t("invalidName"),
        variant: "destructive"
      })
      return
    }

    setLoading(true)
    try {
      const response = await fetch("/api/emails/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(normalizedEmailName ? { name: normalizedEmailName } : {}),
          domain: currentDomain,
          expiryTime: parseInt(expiryTime)
        })
      })

      if (!response.ok) {
        const code = await readApiErrorCode(response, "MAILBOX_CREATE_FAILED")
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
      onEmailCreated()
      setOpen(false)
      setEmailName("")
      setDiscardedDomain(false)
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

  useEffect(() => {
    const availableDomains = config?.domains ?? []
    setCurrentDomain(current => (
      availableDomains.some(option => option.domain === current)
        ? current
        : availableDomains.find(option => !option.usageWarning)?.domain
          ?? availableDomains[0]?.domain
          ?? ""
    ))
  }, [config])

  return (
    <Dialog open={open} onOpenChange={nextOpen => {
      setOpen(nextOpen)
      if (nextOpen) void refreshConfig()
    }}>
      <DialogTrigger asChild>
        <Button className="gap-2" disabled={(config?.domains.length ?? 0) === 0} title={(config?.domains.length ?? 0) === 0 ? t("noAvailableDomains") : undefined}>
          <Plus className="w-4 h-4" />
          {t("title")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,12rem)_auto]">
              <Input
                value={emailName}
                onChange={event => {
                  const value = event.target.value
                  setDiscardedDomain(value.includes("@"))
                  setEmailName(value.split("@", 1)[0].slice(0, 64))
                }}
                placeholder={t("namePlaceholder")}
                maxLength={64}
                pattern="[A-Za-z0-9._+-]+"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0"
              />
              <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-auto">
                {(config?.domains.length ?? 0) > 1 ? (
                  <Select value={currentDomain} onValueChange={setCurrentDomain}>
                    <SelectTrigger
                      className={`gap-2 [&>svg:last-child]:shrink-0 ${selectedDomain?.usageWarning ? "border-amber-500/60 bg-amber-500/5 text-amber-800 dark:text-amber-200" : ""}`}
                      aria-describedby={selectedDomain?.usageWarning ? usageWarningDescriptionId : undefined}
                      title={`@${currentDomain}`}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-left">@{currentDomain}</span>
                        {selectedDomain?.usageWarning && (
                          <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        )}
                      </span>
                    </SelectTrigger>
                    {selectedDomain?.usageWarning && (
                      <span id={usageWarningDescriptionId} className="sr-only">{t("usageWarningInline")}</span>
                    )}
                    <SelectContent>
                      {config?.domains.map(option => (
                        <SelectItem
                          key={option.domain}
                          value={option.domain}
                          className="[&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
                        >
                          <span className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 ${option.usageWarning ? "text-amber-700 dark:text-amber-300" : ""}`}>
                            <span className="truncate">@{option.domain}</span>
                            {option.usageWarning && (
                              <span className="flex shrink-0 items-center gap-1.5">
                                <TriangleAlert className="h-3.5 w-3.5" />
                                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium">
                                  {t("usageWarningBadge")}
                                </span>
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div
                    className={`flex h-9 min-w-0 items-center gap-2 rounded-md border px-3 text-sm ${selectedDomain?.usageWarning ? "border-amber-500/60 bg-amber-500/5 text-amber-800 dark:text-amber-200" : "bg-muted/30 text-muted-foreground"}`}
                    title={`@${currentDomain}`}
                  >
                    <span className="min-w-0 flex-1 truncate">@{currentDomain}</span>
                    {selectedDomain?.usageWarning && (
                      <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    )}
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={generateRandomName}
                type="button"
                aria-label={t("randomName")}
                title={t("randomName")}
                className="col-start-2 row-start-1 sm:col-auto sm:row-auto"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>

            <div aria-live="polite" className="h-10 overflow-hidden sm:h-5">
              {invalidEmailName ? (
                <p className="line-clamp-2 text-xs leading-5 text-destructive sm:line-clamp-1">{t("invalidName")}</p>
              ) : discardedDomain ? (
                <p className="line-clamp-2 text-xs leading-5 text-muted-foreground sm:line-clamp-1">{t("domainDiscarded")}</p>
              ) : selectedDomain?.usageWarning ? (
                <p className="flex items-start gap-1.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="line-clamp-2 sm:line-clamp-1">{t("usageWarningInline")}</span>
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-4">
            <Label className="shrink-0 text-muted-foreground">{t("expiryTime")}</Label>
            <RadioGroup
              value={expiryTime}
              onValueChange={setExpiryTime}
              className="grid grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:flex-wrap sm:gap-x-6"
            >
              {EXPIRY_OPTIONS.map(option => {
                return (
                  <div key={option.value} className="flex items-center gap-2">
                    <RadioGroupItem value={option.value.toString()} id={option.value.toString()} />
                    <Label htmlFor={option.value.toString()} className="cursor-pointer text-sm">
                      {t(option.key)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="shrink-0">{tFormat("label", { label: t("domain") })}</span>
            {normalizedEmailName ? (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">{`${normalizedEmailName}@${currentDomain}`}</span>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer transition-colors hover:text-primary"
                  onClick={copyEmailAddress}
                  aria-label={tCommon("copy")}
                  title={tCommon("copy")}
                >
                  <Copy className="size-4" />
                </button>
              </div>
            ) : (
              <span className="text-gray-400">...</span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={createEmail} disabled={loading || invalidEmailName || !currentDomain}>
            {loading ? t("creating") : t("create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
