"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, ChevronDown, Code2, RotateCcw, Save, ShieldAlert, Trash2, Type } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/use-toast"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"
import { MAX_APPEARANCE_FRAGMENT_BYTES, MAX_APPEARANCE_TOTAL_BYTES } from "@/lib/appearance-values"

const presets = [
  { key: "pixel", value: "var(--font-zpix), sans-serif" },
  { key: "sans", value: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif" },
  { key: "mono", value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { key: "serif", value: "ui-serif, Georgia, Cambria, serif" },
]

interface AppearanceResponse {
  fontFamily?: string
  defaultFontFamily?: string
  advancedEditable?: boolean
  advancedEnabled?: boolean
  customCss?: string
  headHtml?: string
  bodyEndHtml?: string
  customJs?: string
  customJsEnabled?: boolean
  error?: string
}

type PendingAdvancedAction = "save" | "clear" | null

export function AppearancePanel({ allowAdvanced = false }: { allowAdvanced?: boolean }) {
  const format = useFormatter()
  const t = useTranslations("admin.appearance")
  const tApi = useTranslations("api")
  const [fontFamily, setFontFamily] = useState("")
  const [defaultFontFamily, setDefaultFontFamily] = useState(presets[0].value)
  const [advancedEditable, setAdvancedEditable] = useState(false)
  const [advancedEnabled, setAdvancedEnabled] = useState(false)
  const [customCss, setCustomCss] = useState("")
  const [headHtml, setHeadHtml] = useState("")
  const [bodyEndHtml, setBodyEndHtml] = useState("")
  const [customJs, setCustomJs] = useState("")
  const [customJsEnabled, setCustomJsEnabled] = useState(false)
  const [advancedSection, setAdvancedSection] = useState<"css" | "html" | "javascript">("css")
  const [saving, setSaving] = useState(false)
  const [advancedSaving, setAdvancedSaving] = useState(false)
  const [pendingAdvancedAction, setPendingAdvancedAction] = useState<PendingAdvancedAction>(null)
  const [error, setError] = useState("")
  const { toast } = useToast()
  const canEditAdvanced = allowAdvanced && advancedEditable
  const advancedBytes = useMemo(() => {
    const encoder = new TextEncoder()
    const fragments = {
      customCss: encoder.encode(customCss).byteLength,
      headHtml: encoder.encode(headHtml).byteLength,
      bodyEndHtml: encoder.encode(bodyEndHtml).byteLength,
      customJs: encoder.encode(customJs).byteLength,
    }
    return { fragments, total: Object.values(fragments).reduce((sum, value) => sum + value, 0) }
  }, [bodyEndHtml, customCss, customJs, headHtml])
  const advancedTooLarge = advancedBytes.total > MAX_APPEARANCE_TOTAL_BYTES
    || Object.values(advancedBytes.fragments).some(value => value > MAX_APPEARANCE_FRAGMENT_BYTES)

  const applyAdvanced = useCallback((body: AppearanceResponse) => {
    setAdvancedEnabled(Boolean(body.advancedEnabled))
    setCustomCss(body.customCss ?? "")
    setHeadHtml(body.headHtml ?? "")
    setBodyEndHtml(body.bodyEndHtml ?? "")
    setCustomJs(body.customJs ?? "")
    setCustomJsEnabled(Boolean(body.customJsEnabled))
  }, [])

  useEffect(() => {
    void fetch("/api/config/appearance", { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as AppearanceResponse
        if (!response.ok || !body.fontFamily) {
          throw new LocalizedUiError(tApi(await readApiErrorCode(response, "APPEARANCE_READ_FAILED") as never))
        }
        setFontFamily(body.fontFamily)
        setDefaultFontFamily(body.defaultFontFamily || presets[0].value)
        setAdvancedEditable(Boolean(body.advancedEditable))
        applyAdvanced(body)
      })
      .catch(caught => {
        console.error("appearance.load_failed", caught)
        setError(localizedUiErrorMessage(caught, t("errors.load")))
      })
  }, [applyAdvanced, t, tApi])

  const saveFont = async (next = fontFamily) => {
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/config/appearance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fontFamily: next }),
      })
      const body = await response.json() as AppearanceResponse
      if (!response.ok || !body.fontFamily) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "APPEARANCE_SAVE_FAILED") as never))
      setFontFamily(body.fontFamily)
      document.body.style.setProperty("--moemail-ui-font-family", body.fontFamily)
      toast({ title: t("success.fontTitle"), description: t("success.fontDescription") })
    } catch (caught) {
      console.error("appearance.font_save_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.saveFont")))
    } finally {
      setSaving(false)
    }
  }

  const saveAdvanced = async (clear: boolean) => {
    setAdvancedSaving(true)
    setError("")
    try {
      const payload = clear ? {
        advancedEnabled: false,
        customCss: "",
        headHtml: "",
        bodyEndHtml: "",
        customJs: "",
        customJsEnabled: false,
      } : {
        advancedEnabled,
        customCss,
        headHtml,
        bodyEndHtml,
        customJs,
        customJsEnabled,
      }
      const response = await fetch("/api/config/appearance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await response.json() as AppearanceResponse
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "APPEARANCE_SAVE_FAILED") as never))
      applyAdvanced(body)
      toast({
        title: clear ? t("success.advancedClearedTitle") : t("success.advancedSavedTitle"),
        description: clear ? t("success.advancedClearedDescription") : t("success.advancedSavedDescription"),
      })
    } catch (caught) {
      console.error("appearance.advanced_save_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.saveAdvanced")))
    } finally {
      setAdvancedSaving(false)
      setPendingAdvancedAction(null)
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
        <div className="mb-4 flex items-center gap-2"><Type className="h-5 w-5 text-primary" /><div><h2 className="font-semibold">{t("font.title")}</h2><p className="text-xs text-muted-foreground">{t("font.description")}</p></div></div>
        {error && <div className="mb-3 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-2"><Label>{t("font.family")}</Label><Input value={fontFamily} onChange={event => setFontFamily(event.target.value)} spellCheck={false} /><div className="flex flex-wrap gap-2">{presets.map(preset => <Button key={preset.key} type="button" variant="outline" size="sm" onClick={() => setFontFamily(preset.value)}>{t(`font.presets.${preset.key}` as never)}</Button>)}</div></div>
          <div className="rounded border p-3" style={{ fontFamily }}><p className="text-xs text-muted-foreground">{t("font.preview")}</p><p className="mt-2 text-lg">{t("font.previewPrimary")}</p><p className="text-sm">{t("font.previewSecondary")}</p></div>
        </div>
        <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => { setFontFamily(defaultFontFamily); void saveFont(defaultFontFamily) }} disabled={saving}><RotateCcw className="mr-1 h-4 w-4" />{t("font.restoreDefault")}</Button><Button onClick={() => void saveFont()} disabled={saving || !fontFamily}><Save className="mr-1 h-4 w-4" />{t("font.save")}</Button></div>
      </section>

      {allowAdvanced && (
        <details className="group overflow-hidden rounded-lg border border-amber-500/45 bg-background shadow-sm">
          <summary className="grid min-h-14 cursor-pointer list-none grid-cols-[2rem_minmax(0,1fr)_1.5rem] items-center gap-2.5 px-3 py-2.5 outline-none transition-colors hover:bg-amber-500/[0.05] focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-inset sm:grid-cols-[2.25rem_minmax(0,1fr)_1.5rem] sm:gap-3 [&::-webkit-details-marker]:hidden">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-amber-500/10 sm:h-9 sm:w-9"><Code2 className="h-4 w-4 text-amber-700 dark:text-amber-300 sm:h-5 sm:w-5" /></span>
            <span className="min-w-0"><span className="block font-semibold leading-tight">{t("advanced.title")}</span><span className="mt-0.5 block text-xs font-normal leading-snug text-muted-foreground [overflow-wrap:anywhere]">{t("advanced.subtitle")}</span><span className="mt-1.5 flex min-w-0 flex-wrap gap-1.5 text-[10px] font-medium leading-4"><span className={`rounded-full px-2 ${advancedEnabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground"}`}>{advancedEnabled ? t("advanced.statusEnabled") : t("advanced.statusDisabled")}</span><span className={`rounded-full px-2 ${advancedTooLarge ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{advancedBytes.total > 0 ? t("advanced.summaryBytes", { used: format.number(advancedBytes.total) }) : t("advanced.summaryEmpty")}</span></span></span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <div className="space-y-4 border-t border-amber-500/25 p-3 sm:p-4">
            {!canEditAdvanced ? (
              <div className="rounded border border-amber-500/60 bg-amber-500/10 p-3 text-sm">{t("advanced.emperorOnly")}</div>
            ) : (
              <>
                <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,.65fr)]">
                  <div className="rounded border border-destructive/70 bg-destructive/10 p-3 text-sm">
                    <div className="flex gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div className="min-w-0"><p className="font-medium text-destructive">{t("advanced.warningTitle")}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("advanced.warningDescription")}</p></div></div>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-4 rounded border p-3"><div className="min-w-0"><Label>{t("advanced.enabled")}</Label><p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("advanced.enabledDescription")}</p></div><Switch checked={advancedEnabled} onCheckedChange={setAdvancedEnabled} disabled={advancedSaving} /></div>
                </div>

                <Tabs value={advancedSection} onValueChange={value => setAdvancedSection(value as typeof advancedSection)} className="min-w-0">
                  <TabsList className="grid h-auto w-full grid-cols-3 sm:w-fit sm:min-w-80"><TabsTrigger value="css" className="min-w-0 px-2">{t("advanced.tabs.css")}</TabsTrigger><TabsTrigger value="html" className="min-w-0 px-2">{t("advanced.tabs.html")}</TabsTrigger><TabsTrigger value="javascript" className="min-w-0 px-2">{t("advanced.tabs.javascript")}</TabsTrigger></TabsList>
                  <TabsContent value="css" className="mt-3 min-w-0 space-y-2"><Label>{t("advanced.customCss")}</Label><Textarea value={customCss} onChange={event => setCustomCss(event.target.value)} disabled={advancedSaving} spellCheck={false} placeholder={t.raw("advanced.customCssPlaceholder")} className="min-h-52 resize-y font-mono text-xs leading-5" /><div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-start sm:justify-between"><span className="min-w-0 leading-relaxed [overflow-wrap:anywhere]">{t("advanced.customCssHelp")}</span><span className={`shrink-0 ${advancedBytes.fragments.customCss > MAX_APPEARANCE_FRAGMENT_BYTES ? "text-destructive" : ""}`}>{t("advanced.byteCount", { used: format.number(advancedBytes.fragments.customCss), maximum: format.number(MAX_APPEARANCE_FRAGMENT_BYTES) })}</span></div></TabsContent>
                  <TabsContent value="html" className="mt-3 min-w-0"><div className="grid min-w-0 gap-3 xl:grid-cols-2"><div className="min-w-0 space-y-2"><Label>{t("advanced.headHtml")}</Label><Textarea value={headHtml} onChange={event => setHeadHtml(event.target.value)} disabled={advancedSaving} spellCheck={false} placeholder={t.raw("advanced.headHtmlPlaceholder")} className="min-h-52 resize-y font-mono text-xs leading-5" /><p className={`text-right text-xs ${advancedBytes.fragments.headHtml > MAX_APPEARANCE_FRAGMENT_BYTES ? "text-destructive" : "text-muted-foreground"}`}>{t("advanced.byteCount", { used: format.number(advancedBytes.fragments.headHtml), maximum: format.number(MAX_APPEARANCE_FRAGMENT_BYTES) })}</p></div><div className="min-w-0 space-y-2"><Label>{t("advanced.bodyEndHtml")}</Label><Textarea value={bodyEndHtml} onChange={event => setBodyEndHtml(event.target.value)} disabled={advancedSaving} spellCheck={false} placeholder={t.raw("advanced.bodyEndHtmlPlaceholder")} className="min-h-52 resize-y font-mono text-xs leading-5" /><p className={`text-right text-xs ${advancedBytes.fragments.bodyEndHtml > MAX_APPEARANCE_FRAGMENT_BYTES ? "text-destructive" : "text-muted-foreground"}`}>{t("advanced.byteCount", { used: format.number(advancedBytes.fragments.bodyEndHtml), maximum: format.number(MAX_APPEARANCE_FRAGMENT_BYTES) })}</p></div></div></TabsContent>
                  <TabsContent value="javascript" className="mt-3 min-w-0 space-y-2"><div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><Label>{t("advanced.customJs")}</Label><p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t.raw("advanced.customJsHelp")}</p></div><div className="flex shrink-0 items-center justify-between gap-2 rounded border px-2.5 py-2 sm:justify-start"><Label htmlFor="custom-js-enabled" className="text-xs">{t("advanced.allowExecution")}</Label><Switch id="custom-js-enabled" checked={customJsEnabled} onCheckedChange={setCustomJsEnabled} disabled={advancedSaving} /></div></div><Textarea value={customJs} onChange={event => setCustomJs(event.target.value)} disabled={advancedSaving} spellCheck={false} placeholder={t("advanced.customJsPlaceholder")} className="min-h-52 resize-y font-mono text-xs leading-5" /><p className={`text-right text-xs ${advancedBytes.fragments.customJs > MAX_APPEARANCE_FRAGMENT_BYTES ? "text-destructive" : "text-muted-foreground"}`}>{t("advanced.byteCount", { used: format.number(advancedBytes.fragments.customJs), maximum: format.number(MAX_APPEARANCE_FRAGMENT_BYTES) })}</p></TabsContent>
                </Tabs>

                <div className="grid min-w-0 gap-3 lg:grid-cols-2"><div className="rounded border border-amber-500/60 bg-amber-500/10 p-3 text-xs"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" /><p className="leading-relaxed [overflow-wrap:anywhere]">{t("advanced.safeMode")}</p></div></div><div className={`rounded border p-3 text-xs ${advancedTooLarge ? "border-destructive/60 bg-destructive/10 text-destructive" : "text-muted-foreground"}`}><p className="leading-relaxed [overflow-wrap:anywhere]">{t("advanced.limits", { fragment: format.number(MAX_APPEARANCE_FRAGMENT_BYTES / 1024), total: format.number(MAX_APPEARANCE_TOTAL_BYTES / 1024) })}</p><p className="mt-1 font-medium">{t("advanced.totalByteCount", { used: format.number(advancedBytes.total), maximum: format.number(MAX_APPEARANCE_TOTAL_BYTES) })}</p></div></div>

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setPendingAdvancedAction("clear")} disabled={advancedSaving}><Trash2 className="mr-1 h-4 w-4" />{t("advanced.clear")}</Button><Button type="button" onClick={() => setPendingAdvancedAction("save")} disabled={advancedSaving || advancedTooLarge}><Save className="mr-1 h-4 w-4" />{t("advanced.save")}</Button></div>
              </>
            )}
          </div>
        </details>
      )}

      <AlertDialog open={pendingAdvancedAction !== null} onOpenChange={open => { if (!open && !advancedSaving) setPendingAdvancedAction(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingAdvancedAction === "clear" ? t("advanced.clearTitle") : t("advanced.saveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAdvancedAction === "clear"
                ? t("advanced.clearDescription")
                : t("advanced.saveDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={advancedSaving}>{t("advanced.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void saveAdvanced(pendingAdvancedAction === "clear")} disabled={advancedSaving} className={pendingAdvancedAction === "clear" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>{advancedSaving ? t("advanced.saving") : t("advanced.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
