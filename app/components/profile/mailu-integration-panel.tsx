"use client"

import { useCallback, useEffect, useState } from "react"
import { KeyRound, Loader2, Plus, PlugZap, RefreshCw, Save, ServerCog } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SecretInput } from "@/components/ui/secret-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"

type Security = "plain" | "starttls" | "tls"
type Integration = {
  version: 1
  integrationId: string
  enabled: boolean
  api: { baseUrl: string; token: string; timeoutSeconds: number }
  collector: { address: string; password: string }
  catchAll: { address: string; password: string }
  imap: {
    host: string; port: number; security: Security; rejectUnauthorized: boolean
    mailbox: string; recipientHeader: "x-original-to" | "delivered-to" | "envelope-to" | "x-envelope-to"
    initialSync: "new" | "unseen"; pollIntervalSeconds: number; maxMessagesPerPoll: number
  }
  smtp: {
    host: string; port: number; security: Security; authMethod: "auto" | "plain" | "login"
    rejectUnauthorized: boolean; fromName: string | null
  }
  reconciliation: { enabled: boolean; intervalSeconds: number; createCatchAll: boolean; removeStaleAliases: boolean }
  retention:
    | { action: "keep" }
    | { action: "delete"; delaySeconds: number }
    | { action: "archive"; delaySeconds: number; mailbox: string }
}

type Action = "testApi" | "testImap" | "testSmtp" | "discover" | "reconcile" | "rotateCollector" | "rotateCatchAll"

export function MailuIntegrationPanel({ onDomainsDiscovered, canImportDomains }: {
  onDomainsDiscovered: (domains: string[]) => void
  canImportDomains: boolean
}) {
  const t = useTranslations("domains.mailu")
  const format = useFormatter()
  const tApi = useTranslations("api")
  const { toast } = useToast()
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState("")
  const [discoveredDomains, setDiscoveredDomains] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const response = await fetch("/api/config/mailu", { cache: "no-store" })
      const body = await response.json() as { integration?: Integration }
      if (!response.ok || !body.integration) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILU_CONFIG_READ_FAILED") as never))
      setIntegration(body.integration)
    } catch (caught) {
      setError(localizedUiErrorMessage(caught, t("errors.load")))
    } finally { setLoading(false) }
  }, [t, tApi])
  useEffect(() => { void load() }, [load])

  const patch = (update: Partial<Integration>) => setIntegration(previous => previous ? { ...previous, ...update } : previous)
  const randomSecret = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "")
  }
  const updateCollectorSecret = () => {
    if (!integration) return
    if (integration.enabled) void run("rotateCollector")
    else patch({ collector: { ...integration.collector, password: randomSecret() } })
  }
  const updateCatchAllSecret = () => {
    if (!integration) return
    if (integration.enabled) void run("rotateCatchAll")
    else patch({ catchAll: { ...integration.catchAll, password: randomSecret() } })
  }
  const save = async () => {
    if (!integration) return
    setSaving(true); setError("")
    try {
      const response = await fetch("/api/config/mailu", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(integration) })
      const body = await response.json() as { integration?: Integration }
      if (!response.ok || !body.integration) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILU_CONFIG_SAVE_FAILED") as never))
      setIntegration(body.integration)
      toast({ title: t("success.saved") })
    } catch (caught) { setError(localizedUiErrorMessage(caught, t("errors.save"))) } finally { setSaving(false) }
  }

  const run = async (kind: Action) => {
    if (!integration) return
    setAction(kind); setError("")
    try {
      const rotate = kind === "rotateCollector" || kind === "rotateCatchAll"
      const response = await fetch("/api/config/mailu", {
        method: rotate ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rotate
          ? { rotate: kind === "rotateCollector" ? "collector" : "catchAll" }
          : kind === "reconcile" ? { kind } : { kind, integration }),
      })
      const body = await response.json() as { integration?: Integration; domains?: string[]; created?: number; updated?: number; removed?: number }
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILU_CONNECTION_FAILED") as never))
      if (body.integration) setIntegration(body.integration)
      if (body.domains) setDiscoveredDomains(body.domains)
      toast({ title: t(`success.${kind}` as never), description: kind === "reconcile" ? t("success.reconcileCounts", { created: body.created ?? 0, updated: body.updated ?? 0, removed: body.removed ?? 0 }) : undefined })
    } catch (caught) { setError(localizedUiErrorMessage(caught, t(`errors.${kind}` as never))) } finally { setAction(null) }
  }

  if (loading) return <div className="flex min-h-28 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
  if (!integration) return null
  const retentionDelay = integration.retention.action === "keep" ? 0 : integration.retention.delaySeconds
  const setRetentionDelay = (delaySeconds: number) => {
    if (integration.retention.action === "delete") patch({ retention: { action: "delete", delaySeconds } })
    if (integration.retention.action === "archive") patch({ retention: { ...integration.retention, delaySeconds } })
  }
  const setArchiveMailbox = (mailbox: string) => {
    if (integration.retention.action === "archive") patch({ retention: { ...integration.retention, mailbox } })
  }
  const busy = saving || action !== null

  return (
    <section className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 font-semibold"><ServerCog className="h-5 w-5 text-primary" />{t("title")}</div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t("description")}</p></div><div className="flex items-center gap-3"><Label htmlFor="mailu-enabled">{t("enabled")}</Label><Switch id="mailu-enabled" checked={integration.enabled} onCheckedChange={enabled => patch({ enabled })} /></div></div>
      {error && <div className="mb-4 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <fieldset className="grid gap-3 rounded border p-4 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">{t("api.title")}</legend><div className="space-y-2 sm:col-span-2"><Label>{t("api.baseUrl")}</Label><Input value={integration.api.baseUrl} onChange={event => patch({ api: { ...integration.api, baseUrl: event.target.value } })} /></div><div className="space-y-2"><Label>{t("api.token")}</Label><SecretInput autoComplete="off" showLabel={t("showSecret")} hideLabel={t("hideSecret")} value={integration.api.token} onChange={event => patch({ api: { ...integration.api, token: event.target.value } })} /></div><div className="space-y-2"><Label>{t("api.timeout")}</Label><Input type="number" min={2} max={60} value={integration.api.timeoutSeconds} onChange={event => patch({ api: { ...integration.api, timeoutSeconds: Number(event.target.value) } })} /></div><div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run("testApi")}><PlugZap className="mr-1 h-4 w-4" />{t("actions.testApi")}</Button><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run("discover")}><RefreshCw className="mr-1 h-4 w-4" />{t("actions.discover")}</Button>{canImportDomains && discoveredDomains.length > 0 && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onDomainsDiscovered(discoveredDomains)}><Plus className="mr-1 h-4 w-4" />{t("actions.importDomains", { count: discoveredDomains.length })}</Button>}</div>{discoveredDomains.length > 0 && <p className="break-all text-xs text-muted-foreground sm:col-span-2">{format.list(discoveredDomains, { type: "unit" })}</p>}</fieldset>
        <fieldset className="grid gap-3 rounded border p-4 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">{t("accounts.title")}</legend><div className="space-y-2"><Label>{t("accounts.collector")}</Label><Input disabled={integration.enabled} autoComplete="off" value={integration.collector.address} onChange={event => patch({ collector: { ...integration.collector, address: event.target.value } })} /></div><div className="space-y-2"><Label>{t("accounts.collectorPassword")}</Label><SecretInput disabled={integration.enabled} autoComplete="new-password" showLabel={t("showSecret")} hideLabel={t("hideSecret")} value={integration.collector.password} onChange={event => patch({ collector: { ...integration.collector, password: event.target.value } })} /></div><div className="space-y-2"><Label>{t("accounts.catchAll")}</Label><Input disabled={integration.enabled} autoComplete="off" value={integration.catchAll.address} onChange={event => patch({ catchAll: { ...integration.catchAll, address: event.target.value } })} /></div><div className="space-y-2"><Label>{t("accounts.catchAllPassword")}</Label><SecretInput disabled={integration.enabled} autoComplete="new-password" showLabel={t("showSecret")} hideLabel={t("hideSecret")} value={integration.catchAll.password} onChange={event => patch({ catchAll: { ...integration.catchAll, password: event.target.value } })} /></div><p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t("accounts.safety")}</p><div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={updateCollectorSecret}><KeyRound className="mr-1 h-4 w-4" />{t(integration.enabled ? "actions.rotateCollector" : "actions.generateCollector")}</Button><Button type="button" variant="outline" size="sm" disabled={busy} onClick={updateCatchAllSecret}><KeyRound className="mr-1 h-4 w-4" />{t(integration.enabled ? "actions.rotateCatchAll" : "actions.generateCatchAll")}</Button></div></fieldset>
        <fieldset className="grid gap-3 rounded border p-4 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">{t("imap.title")}</legend><div className="space-y-2"><Label>{t("host")}</Label><Input value={integration.imap.host} onChange={event => patch({ imap: { ...integration.imap, host: event.target.value } })} /></div><div className="space-y-2"><Label>{t("port")}</Label><Input type="number" min={1} max={65535} value={integration.imap.port} onChange={event => patch({ imap: { ...integration.imap, port: Number(event.target.value) } })} /></div><div className="space-y-2"><Label>{t("security")}</Label><Select value={integration.imap.security} onValueChange={security => patch({ imap: { ...integration.imap, security: security as Security } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["tls", "starttls", "plain"].map(value => <SelectItem key={value} value={value}>{t(`securityOptions.${value}` as never)}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>{t("imap.mailbox")}</Label><Input value={integration.imap.mailbox} onChange={event => patch({ imap: { ...integration.imap, mailbox: event.target.value } })} /></div><div className="space-y-2"><Label>{t("imap.recipientHeader")}</Label><Select value={integration.imap.recipientHeader} onValueChange={recipientHeader => patch({ imap: { ...integration.imap, recipientHeader: recipientHeader as Integration["imap"]["recipientHeader"] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["delivered-to", "x-original-to", "envelope-to", "x-envelope-to"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>{t("imap.initialSync")}</Label><Select value={integration.imap.initialSync} onValueChange={initialSync => patch({ imap: { ...integration.imap, initialSync: initialSync as Integration["imap"]["initialSync"] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="new">{t("imap.initialSyncOptions.new")}</SelectItem><SelectItem value="unseen">{t("imap.initialSyncOptions.unseen")}</SelectItem></SelectContent></Select></div><div className="space-y-2"><Label>{t("imap.pollInterval")}</Label><Input type="number" min={15} max={86400} value={integration.imap.pollIntervalSeconds} onChange={event => patch({ imap: { ...integration.imap, pollIntervalSeconds: Number(event.target.value) } })} /></div><div className="space-y-2"><Label>{t("imap.maxMessages")}</Label><Input type="number" min={1} max={1000} value={integration.imap.maxMessagesPerPoll} onChange={event => patch({ imap: { ...integration.imap, maxMessagesPerPoll: Number(event.target.value) } })} /></div><div className="flex items-center justify-between gap-3 rounded border p-3 sm:col-span-2"><Label>{t("strictCertificate")}</Label><Switch checked={integration.imap.rejectUnauthorized} onCheckedChange={rejectUnauthorized => patch({ imap: { ...integration.imap, rejectUnauthorized } })} /></div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run("testImap")}><PlugZap className="mr-1 h-4 w-4" />{t("actions.testImap")}</Button></fieldset>
        <fieldset className="grid gap-3 rounded border p-4 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">{t("smtp.title")}</legend><div className="space-y-2"><Label>{t("host")}</Label><Input value={integration.smtp.host} onChange={event => patch({ smtp: { ...integration.smtp, host: event.target.value } })} /></div><div className="space-y-2"><Label>{t("port")}</Label><Input type="number" min={1} max={65535} value={integration.smtp.port} onChange={event => patch({ smtp: { ...integration.smtp, port: Number(event.target.value) } })} /></div><div className="space-y-2"><Label>{t("security")}</Label><Select value={integration.smtp.security} onValueChange={security => patch({ smtp: { ...integration.smtp, security: security as Security } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["tls", "starttls", "plain"].map(value => <SelectItem key={value} value={value}>{t(`securityOptions.${value}` as never)}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><Label>{t("smtp.authMethod")}</Label><Select value={integration.smtp.authMethod} onValueChange={authMethod => patch({ smtp: { ...integration.smtp, authMethod: authMethod as Integration["smtp"]["authMethod"] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["auto", "plain", "login"].map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2 sm:col-span-2"><Label>{t("smtp.fromName")}</Label><Input value={integration.smtp.fromName ?? ""} onChange={event => patch({ smtp: { ...integration.smtp, fromName: event.target.value || null } })} /></div><div className="flex items-center justify-between gap-3 rounded border p-3 sm:col-span-2"><Label>{t("strictCertificate")}</Label><Switch checked={integration.smtp.rejectUnauthorized} onCheckedChange={rejectUnauthorized => patch({ smtp: { ...integration.smtp, rejectUnauthorized } })} /></div><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run("testSmtp")}><PlugZap className="mr-1 h-4 w-4" />{t("actions.testSmtp")}</Button></fieldset>
        <fieldset className="grid gap-3 rounded border p-4 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">{t("retention.title")}</legend><div className="space-y-2"><Label>{t("retention.action")}</Label><Select value={integration.retention.action} onValueChange={value => patch({ retention: value === "keep" ? { action: "keep" } : value === "delete" ? { action: "delete", delaySeconds: retentionDelay } : { action: "archive", delaySeconds: retentionDelay, mailbox: "MoeMail Archive" } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["keep", "delete", "archive"].map(value => <SelectItem key={value} value={value}>{t(`retention.actions.${value}` as never)}</SelectItem>)}</SelectContent></Select></div>{integration.retention.action !== "keep" && <div className="space-y-2"><Label>{t("retention.delay")}</Label><Input type="number" min={0} max={2592000} value={integration.retention.delaySeconds} onChange={event => setRetentionDelay(Number(event.target.value))} /></div>}{integration.retention.action === "archive" && <div className="space-y-2 sm:col-span-2"><Label>{t("retention.mailbox")}</Label><Input value={integration.retention.mailbox} onChange={event => setArchiveMailbox(event.target.value)} /></div>}<p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t("retention.safety")}</p></fieldset>
        <fieldset className="grid gap-3 rounded border p-4 sm:grid-cols-2"><legend className="px-1 text-sm font-medium">{t("reconcile.title")}</legend>{(["enabled", "createCatchAll", "removeStaleAliases"] as const).map(key => <div key={key} className="flex items-center justify-between gap-3 rounded border p-3"><Label>{t(`reconcile.${key}` as never)}</Label><Switch checked={integration.reconciliation[key]} onCheckedChange={value => patch({ reconciliation: { ...integration.reconciliation, [key]: value } })} /></div>)}<div className="space-y-2"><Label>{t("reconcile.interval")}</Label><Input type="number" min={30} max={86400} value={integration.reconciliation.intervalSeconds} onChange={event => patch({ reconciliation: { ...integration.reconciliation, intervalSeconds: Number(event.target.value) } })} /></div><p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t("reconcile.safety")}</p><Button type="button" variant="outline" size="sm" disabled={busy || !integration.enabled} onClick={() => void run("reconcile")}><RefreshCw className="mr-1 h-4 w-4" />{t("actions.reconcile")}</Button></fieldset>
      </div>
      <div className="mt-4 flex justify-end"><Button type="button" disabled={busy} onClick={() => void save()}><Save className="mr-1 h-4 w-4" />{saving ? t("actions.saving") : t("actions.save")}</Button></div>
    </section>
  )
}
