"use client"

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Settings } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import { useState, useEffect } from "react"
import { Role, ROLES } from "@/lib/permissions"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Eye, EyeOff } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"

export function WebsiteConfigPanel() {
  const t = useTranslations("profile.website")
  const tCard = useTranslations("profile.card")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const [defaultRole, setDefaultRole] = useState<string>("")
  const [adminContact, setAdminContact] = useState<string>("")
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState("")
  const [turnstileSecretKey, setTurnstileSecretKey] = useState("")
  const [showSecretKey, setShowSecretKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()


  useEffect(() => {
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    const res = await fetch("/api/config")
    if (res.ok) {
      const data = await res.json() as { 
        defaultRole: Exclude<Role, typeof ROLES.EMPEROR>,
        adminContact: string,
        turnstile?: {
          enabled: boolean,
          siteKey: string,
          secretKey?: string
        }
      }
      setDefaultRole(data.defaultRole)
      setAdminContact(data.adminContact)
      setTurnstileEnabled(Boolean(data.turnstile?.enabled))
      setTurnstileSiteKey(data.turnstile?.siteKey ?? "")
      setTurnstileSecretKey(data.turnstile?.secretKey ?? "")
    }
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          defaultRole, 
          adminContact,
          turnstile: {
            enabled: turnstileEnabled,
            siteKey: turnstileSiteKey,
            secretKey: turnstileSecretKey
          }
        }),
      })

      if (!res.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(res, "CONFIG_SAVE_FAILED") as never))

      toast({
        title: t("saveSuccess"),
        description: t("saveSuccess"),
      })
    } catch (error) {
      console.error("website_config.save_failed", error)
      toast({
        title: t("saveFailed"),
        description: localizedUiErrorMessage(error, t("saveFailed")),
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-background rounded-lg border-2 border-primary/20 p-6">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <span className="text-sm">{tFormat("label", { label: t("defaultRole") })}</span>
          <Select value={defaultRole} onValueChange={setDefaultRole}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROLES.DUKE}>{tCard("roles.DUKE")}</SelectItem>
              <SelectItem value={ROLES.KNIGHT}>{tCard("roles.KNIGHT")}</SelectItem>
              <SelectItem value={ROLES.CIVILIAN}>{tCard("roles.CIVILIAN")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-sm">{tFormat("label", { label: t("adminContact") })}</span>
          <div className="flex-1">
            <Input 
              value={adminContact}
              onChange={(e) => setAdminContact(e.target.value)}
              placeholder={t("adminContactPlaceholder")}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-lg border border-dashed border-primary/40 p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="turnstile-enabled" className="text-sm font-medium">
                {t("turnstile.enable")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("turnstile.enableDescription")}
              </p>
            </div>
            <Switch
              id="turnstile-enabled"
              checked={turnstileEnabled}
              onCheckedChange={setTurnstileEnabled}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turnstile-site-key" className="text-sm font-medium">
              {t("turnstile.siteKey")}
            </Label>
            <Input
              id="turnstile-site-key"
              value={turnstileSiteKey}
              onChange={(e) => setTurnstileSiteKey(e.target.value)}
              placeholder={t("turnstile.siteKeyPlaceholder")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="turnstile-secret-key" className="text-sm font-medium">
              {t("turnstile.secretKey")}
            </Label>
            <div className="relative">
              <Input
                id="turnstile-secret-key"
                type={showSecretKey ? "text" : "password"}
                value={turnstileSecretKey}
                onChange={(e) => setTurnstileSecretKey(e.target.value)}
                placeholder={t("turnstile.secretKeyPlaceholder")}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                onClick={() => setShowSecretKey((prev) => !prev)}
              >
                {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("turnstile.secretKeyDescription")}
            </p>
          </div>
        </div>

        <Button 
          onClick={handleSave}
          disabled={loading}
          className="w-full"
        >
          {t("save")}
        </Button>
      </div>
    </div>
  )
} 
