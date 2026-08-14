"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ChevronDown, KeyRound, Loader2, Plus, PlugZap, RefreshCw, Save, ServerCog } from "lucide-react"
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
    initialSync: "new" | "unseen"
    connectionTimeoutSeconds: number
    realtime: {
      enabled: boolean; mode: "idle"; reconnect: boolean
      idleRenewSeconds: number; reconnectMinSeconds: number; reconnectMaxSeconds: number
    }
    pollIntervalSeconds: number; maxMessagesPerPoll: number
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
type SectionId = "api" | "accounts" | "imap" | "smtp" | "retention" | "reconcile"

const MAILU_SECTIONS = [
  { id: "api", translationKey: "api.title" },
  { id: "accounts", translationKey: "accounts.title" },
  { id: "imap", translationKey: "imap.title" },
  { id: "smtp", translationKey: "smtp.title" },
  { id: "retention", translationKey: "retention.title" },
  { id: "reconcile", translationKey: "reconcile.title" },
] as const satisfies ReadonlyArray<{ id: SectionId; translationKey: string }>

function MailuSettingsSection({ id, active, children }: {
  id: SectionId
  active: boolean
  children: ReactNode
}) {
  if (!active) return null
  return (
    <section
      id={`mailu-panel-${id}`}
      role="region"
      aria-labelledby={`mailu-tab-${id}`}
      className="animate-in rounded-md border bg-card/30 p-3 fade-in slide-in-from-top-1 duration-150 sm:p-4"
    >
      {children}
    </section>
  )
}

export function MailuIntegrationPanel({ onDomainsDiscovered, canImportDomains }: {
  onDomainsDiscovered: (domains: string[]) => void
  canImportDomains: boolean
}) {
  const t = useTranslations("domains.mailu")
  const format = useFormatter()
  const tApi = useTranslations("api")
  const { toast } = useToast()
  const [integration, setIntegration] = useState<Integration | null>(null)
  const [persistedEnabled, setPersistedEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [action, setAction] = useState<Action | null>(null)
  const [error, setError] = useState("")
  const [discoveredDomains, setDiscoveredDomains] = useState<string[]>([])
  const [settingsExpanded, setSettingsExpanded] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>("api")

  const load = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const response = await fetch("/api/config/mailu", { cache: "no-store" })
      const body = await response.json() as { integration?: Integration }
      if (!response.ok || !body.integration) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILU_CONFIG_READ_FAILED") as never))
      setIntegration(body.integration)
      setPersistedEnabled(body.integration.enabled)
      setSettingsExpanded(false)
      setActiveSection("api")
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
    if (persistedEnabled) void run("rotateCollector")
    else patch({ collector: { ...integration.collector, password: randomSecret() } })
  }
  const updateCatchAllSecret = () => {
    if (!integration) return
    if (persistedEnabled) void run("rotateCatchAll")
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
      setPersistedEnabled(body.integration.enabled)
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
      const body = await response.json() as { integration?: Integration; domains?: string[]; created?: number; updated?: number; removed?: number; idleSupported?: boolean }
      if (!response.ok) throw new LocalizedUiError(tApi(await readApiErrorCode(response, "MAILU_CONNECTION_FAILED") as never))
      if (body.integration) setIntegration(body.integration)
      if (body.domains) setDiscoveredDomains(body.domains)
      const description = kind === "reconcile"
        ? t("success.reconcileCounts", { created: body.created ?? 0, updated: body.updated ?? 0, removed: body.removed ?? 0 })
        : kind === "testImap"
          ? t(body.idleSupported ? "success.testImapRealtime" : "success.testImapPolling")
          : undefined
      toast({ title: t(`success.${kind}` as never), description })
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
    <section className="overflow-hidden rounded-lg border-2 border-primary/20 bg-background">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2 sm:gap-3 sm:p-3">
        {integration.enabled ? <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-3"
          aria-expanded={settingsExpanded}
          aria-controls="mailu-settings-content"
          onClick={() => setSettingsExpanded(expanded => !expanded)}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 sm:h-10 sm:w-10">
            <ServerCog className="h-5 w-5 text-primary" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">{t("title")}</span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t("status.enabled")}
              </span>
            </span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{integration.collector.address}</span>
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${settingsExpanded ? "rotate-180" : ""}`} />
        </button> : <div className="flex min-w-0 items-center gap-2 p-1 sm:gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted sm:h-10 sm:w-10">
            <ServerCog className="h-5 w-5 text-muted-foreground" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{t("title")}</span>
            <span className="block truncate text-[11px] text-muted-foreground" title={t("compactDisabled")}>{t("compactDisabled")}</span>
          </span>
        </div>}

        <div className="flex shrink-0 items-center justify-end gap-2">
          <Label htmlFor="mailu-enabled" className="hidden text-xs sm:block">{t("enabled")}</Label>
          <Switch
            id="mailu-enabled"
            aria-label={t("enabled")}
            checked={integration.enabled}
            disabled={busy}
            onCheckedChange={enabled => {
              patch({ enabled })
              if (!enabled) setSettingsExpanded(false)
            }}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 w-8 p-0 sm:w-auto sm:px-3"
            aria-label={saving ? t("actions.saving") : t("actions.save")}
            title={saving ? t("actions.saving") : t("actions.save")}
            disabled={busy}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin sm:mr-1" /> : <Save className="h-4 w-4 sm:mr-1" />}
            <span className="hidden sm:inline">{saving ? t("actions.saving") : t("actions.save")}</span>
          </Button>
        </div>
      </div>

      {error && <div className="mx-2 mb-2 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive sm:mx-3 sm:mb-3">{error}</div>}

      {integration.enabled && settingsExpanded && <div
        id="mailu-settings-content"
        className="animate-in border-t p-3 fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none sm:p-4"
      >
        <p className="mb-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t("description")}</p>
        <div
          role="group"
          aria-label={t("sectionsLabel")}
          className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-1 sm:grid-cols-3 lg:grid-cols-6"
        >
          {MAILU_SECTIONS.map(section => <button
            key={section.id}
            id={`mailu-tab-${section.id}`}
            type="button"
            aria-pressed={activeSection === section.id}
            aria-controls={`mailu-panel-${section.id}`}
            className={`min-h-10 rounded-md px-2 py-1.5 text-xs font-medium leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${activeSection === section.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground"}`}
            onClick={() => setActiveSection(section.id)}
          >
            {t(section.translationKey)}
          </button>)}
        </div>
        <div>
        <MailuSettingsSection
          id="api"
          active={activeSection === "api"}
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1.25fr)_7rem]">
            <div className="min-w-0 space-y-2">
              <Label>{t("api.baseUrl")}</Label>
              <Input value={integration.api.baseUrl} onChange={event => patch({ api: { ...integration.api, baseUrl: event.target.value } })} />
            </div>
            <div className="min-w-0 space-y-2">
              <Label>{t("api.token")}</Label>
              <SecretInput autoComplete="off" showLabel={t("showSecret")} hideLabel={t("hideSecret")} value={integration.api.token} onChange={event => patch({ api: { ...integration.api, token: event.target.value } })} />
            </div>
            <div className="min-w-0 space-y-2">
              <Label>{t("api.timeout")}</Label>
              <Input type="number" min={2} max={60} value={integration.api.timeoutSeconds} onChange={event => patch({ api: { ...integration.api, timeoutSeconds: Number(event.target.value) } })} />
            </div>
            <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-3">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run("testApi")}><PlugZap className="mr-1 h-4 w-4" />{t("actions.testApi")}</Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run("discover")}><RefreshCw className="mr-1 h-4 w-4" />{t("actions.discover")}</Button>
              {canImportDomains && discoveredDomains.length > 0 && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onDomainsDiscovered(discoveredDomains)}><Plus className="mr-1 h-4 w-4" />{t("actions.importDomains", { count: discoveredDomains.length })}</Button>}
            </div>
            {discoveredDomains.length > 0 && <p className="break-all text-xs text-muted-foreground md:col-span-2 xl:col-span-3">{format.list(discoveredDomains, { type: "unit" })}</p>}
          </div>
        </MailuSettingsSection>

        <MailuSettingsSection
          id="accounts"
          active={activeSection === "accounts"}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-2"><Label>{t("accounts.collector")}</Label><Input disabled={persistedEnabled} autoComplete="off" value={integration.collector.address} onChange={event => patch({ collector: { ...integration.collector, address: event.target.value } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("accounts.collectorPassword")}</Label><SecretInput disabled={persistedEnabled} autoComplete="new-password" showLabel={t("showSecret")} hideLabel={t("hideSecret")} value={integration.collector.password} onChange={event => patch({ collector: { ...integration.collector, password: event.target.value } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("accounts.catchAll")}</Label><Input disabled={persistedEnabled} autoComplete="off" value={integration.catchAll.address} onChange={event => patch({ catchAll: { ...integration.catchAll, address: event.target.value } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("accounts.catchAllPassword")}</Label><SecretInput disabled={persistedEnabled} autoComplete="new-password" showLabel={t("showSecret")} hideLabel={t("hideSecret")} value={integration.catchAll.password} onChange={event => patch({ catchAll: { ...integration.catchAll, password: event.target.value } })} /></div>
            <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground md:col-span-2">
              {t(persistedEnabled ? "accounts.locked" : "accounts.editable")}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground md:col-span-2">{t("accounts.safety")}</p>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={updateCollectorSecret}><KeyRound className="mr-1 h-4 w-4" />{t(persistedEnabled ? "actions.rotateCollector" : "actions.generateCollector")}</Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={updateCatchAllSecret}><KeyRound className="mr-1 h-4 w-4" />{t(persistedEnabled ? "actions.rotateCatchAll" : "actions.generateCatchAll")}</Button>
            </div>
          </div>
        </MailuSettingsSection>

        <MailuSettingsSection
          id="imap"
          active={activeSection === "imap"}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="grid gap-2 rounded-md border bg-muted/20 p-2.5 sm:col-span-2 sm:grid-cols-2 xl:col-span-4 xl:grid-cols-4">
              <div className="flex min-h-10 items-center justify-between gap-3 rounded border bg-background px-3">
                <Label htmlFor="mailu-imap-realtime">{t("imap.realtimeEnabled")}</Label>
                <Switch id="mailu-imap-realtime" checked={integration.imap.realtime.enabled} onCheckedChange={enabled => patch({ imap: { ...integration.imap, realtime: { ...integration.imap.realtime, enabled } } })} />
              </div>
              <div className="flex min-h-10 items-center justify-between gap-3 rounded border bg-background px-3">
                <Label>{t("imap.realtimeMode")}</Label>
                <span className="max-w-[13rem] text-right text-xs leading-tight text-muted-foreground">{t("imap.modeIdleAuto")}</span>
              </div>
              <div className="flex min-h-10 items-center justify-between gap-3 rounded border bg-background px-3">
                <Label htmlFor="mailu-imap-reconnect">{t("imap.reconnect")}</Label>
                <Switch id="mailu-imap-reconnect" disabled={!integration.imap.realtime.enabled} checked={integration.imap.realtime.reconnect} onCheckedChange={reconnect => patch({ imap: { ...integration.imap, realtime: { ...integration.imap.realtime, reconnect } } })} />
              </div>
              <div className="grid min-h-10 gap-2 rounded border bg-background px-3 py-2 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center">
                <Label htmlFor="mailu-imap-fallback">{t("imap.fallbackPollInterval")}</Label>
                <Input id="mailu-imap-fallback" className="h-8" type="number" min={15} max={86400} value={integration.imap.pollIntervalSeconds} onChange={event => patch({ imap: { ...integration.imap, pollIntervalSeconds: Number(event.target.value) } })} />
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-4">{t("imap.realtimeHelp")}</p>
            </div>
            <details className="group overflow-hidden rounded border bg-muted/20 sm:col-span-2 xl:col-span-4">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <span>{t("imap.advanced")}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
              </summary>
              <div className="grid gap-3 border-t p-3 sm:grid-cols-2 xl:grid-cols-5">
                <div className="min-w-0 space-y-2"><Label>{t("imap.connectionTimeout")}</Label><Input type="number" min={5} max={120} value={integration.imap.connectionTimeoutSeconds} onChange={event => patch({ imap: { ...integration.imap, connectionTimeoutSeconds: Number(event.target.value) } })} /></div>
                <div className="min-w-0 space-y-2"><Label>{t("imap.idleRenew")}</Label><Input disabled={!integration.imap.realtime.enabled} type="number" min={60} max={1740} value={integration.imap.realtime.idleRenewSeconds} onChange={event => patch({ imap: { ...integration.imap, realtime: { ...integration.imap.realtime, idleRenewSeconds: Number(event.target.value) } } })} /></div>
                <div className="min-w-0 space-y-2"><Label>{t("imap.reconnectMin")}</Label><Input disabled={!integration.imap.realtime.enabled || !integration.imap.realtime.reconnect} type="number" min={1} max={60} value={integration.imap.realtime.reconnectMinSeconds} onChange={event => patch({ imap: { ...integration.imap, realtime: { ...integration.imap.realtime, reconnectMinSeconds: Number(event.target.value) } } })} /></div>
                <div className="min-w-0 space-y-2"><Label>{t("imap.reconnectMax")}</Label><Input disabled={!integration.imap.realtime.enabled || !integration.imap.realtime.reconnect} type="number" min={5} max={300} value={integration.imap.realtime.reconnectMaxSeconds} onChange={event => patch({ imap: { ...integration.imap, realtime: { ...integration.imap.realtime, reconnectMaxSeconds: Number(event.target.value) } } })} /></div>
                <div className="min-w-0 space-y-2"><Label>{t("imap.maxMessages")}</Label><Input type="number" min={1} max={1000} value={integration.imap.maxMessagesPerPoll} onChange={event => patch({ imap: { ...integration.imap, maxMessagesPerPoll: Number(event.target.value) } })} /></div>
                <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-5">{t("imap.advancedHelp")}</p>
              </div>
            </details>
            <div className="min-w-0 space-y-2"><Label>{t("host")}</Label><Input value={integration.imap.host} onChange={event => patch({ imap: { ...integration.imap, host: event.target.value } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("port")}</Label><Input type="number" min={1} max={65535} value={integration.imap.port} onChange={event => patch({ imap: { ...integration.imap, port: Number(event.target.value) } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("security")}</Label><Select value={integration.imap.security} onValueChange={security => patch({ imap: { ...integration.imap, security: security as Security } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["tls", "starttls", "plain"].map(value => <SelectItem key={value} value={value}>{t(`securityOptions.${value}` as never)}</SelectItem>)}</SelectContent></Select></div>
            <div className="min-w-0 space-y-2"><Label>{t("imap.mailbox")}</Label><Input value={integration.imap.mailbox} onChange={event => patch({ imap: { ...integration.imap, mailbox: event.target.value } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("imap.recipientHeader")}</Label><Select value={integration.imap.recipientHeader} onValueChange={recipientHeader => patch({ imap: { ...integration.imap, recipientHeader: recipientHeader as Integration["imap"]["recipientHeader"] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["delivered-to", "x-original-to", "envelope-to", "x-envelope-to"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
            <div className="min-w-0 space-y-2"><Label>{t("imap.initialSync")}</Label><Select value={integration.imap.initialSync} onValueChange={initialSync => patch({ imap: { ...integration.imap, initialSync: initialSync as Integration["imap"]["initialSync"] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="new">{t("imap.initialSyncOptions.new")}</SelectItem><SelectItem value="unseen">{t("imap.initialSyncOptions.unseen")}</SelectItem></SelectContent></Select></div>
            <div className="flex min-h-10 items-center justify-between gap-3 rounded border px-3 sm:col-span-2"><Label>{t("strictCertificate")}</Label><Switch checked={integration.imap.rejectUnauthorized} onCheckedChange={rejectUnauthorized => patch({ imap: { ...integration.imap, rejectUnauthorized } })} /></div>
            <div className="flex items-center sm:col-span-2"><Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" disabled={busy} onClick={() => void run("testImap")}><PlugZap className="mr-1 h-4 w-4" />{t("actions.testImap")}</Button></div>
          </div>
        </MailuSettingsSection>

        <MailuSettingsSection
          id="smtp"
          active={activeSection === "smtp"}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0 space-y-2"><Label>{t("host")}</Label><Input value={integration.smtp.host} onChange={event => patch({ smtp: { ...integration.smtp, host: event.target.value } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("port")}</Label><Input type="number" min={1} max={65535} value={integration.smtp.port} onChange={event => patch({ smtp: { ...integration.smtp, port: Number(event.target.value) } })} /></div>
            <div className="min-w-0 space-y-2"><Label>{t("security")}</Label><Select value={integration.smtp.security} onValueChange={security => patch({ smtp: { ...integration.smtp, security: security as Security } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["tls", "starttls", "plain"].map(value => <SelectItem key={value} value={value}>{t(`securityOptions.${value}` as never)}</SelectItem>)}</SelectContent></Select></div>
            <div className="min-w-0 space-y-2"><Label>{t("smtp.authMethod")}</Label><Select value={integration.smtp.authMethod} onValueChange={authMethod => patch({ smtp: { ...integration.smtp, authMethod: authMethod as Integration["smtp"]["authMethod"] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["auto", "plain", "login"].map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent></Select></div>
            <div className="min-w-0 space-y-2 sm:col-span-2"><Label>{t("smtp.fromName")}</Label><Input value={integration.smtp.fromName ?? ""} onChange={event => patch({ smtp: { ...integration.smtp, fromName: event.target.value || null } })} /></div>
            <div className="flex min-h-10 items-center justify-between gap-3 rounded border px-3 sm:col-span-2"><Label>{t("strictCertificate")}</Label><Switch checked={integration.smtp.rejectUnauthorized} onCheckedChange={rejectUnauthorized => patch({ smtp: { ...integration.smtp, rejectUnauthorized } })} /></div>
            <div className="flex items-center sm:col-span-2 xl:col-span-4"><Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" disabled={busy} onClick={() => void run("testSmtp")}><PlugZap className="mr-1 h-4 w-4" />{t("actions.testSmtp")}</Button></div>
          </div>
        </MailuSettingsSection>

        <MailuSettingsSection
          id="retention"
          active={activeSection === "retention"}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="min-w-0 space-y-2"><Label>{t("retention.action")}</Label><Select value={integration.retention.action} onValueChange={value => patch({ retention: value === "keep" ? { action: "keep" } : value === "delete" ? { action: "delete", delaySeconds: retentionDelay } : { action: "archive", delaySeconds: retentionDelay, mailbox: "MoeMail Archive" } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["keep", "delete", "archive"].map(value => <SelectItem key={value} value={value}>{t(`retention.actions.${value}` as never)}</SelectItem>)}</SelectContent></Select></div>
            {integration.retention.action !== "keep" && <div className="min-w-0 space-y-2"><Label>{t("retention.delay")}</Label><Input type="number" min={0} max={2592000} value={integration.retention.delaySeconds} onChange={event => setRetentionDelay(Number(event.target.value))} /></div>}
            {integration.retention.action === "archive" && <div className="min-w-0 space-y-2"><Label>{t("retention.mailbox")}</Label><Input value={integration.retention.mailbox} onChange={event => setArchiveMailbox(event.target.value)} /></div>}
            <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-3">{t("retention.safety")}</p>
          </div>
        </MailuSettingsSection>

        <MailuSettingsSection
          id="reconcile"
          active={activeSection === "reconcile"}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(["enabled", "createCatchAll", "removeStaleAliases"] as const).map(key => <div key={key} className="flex min-h-10 items-center justify-between gap-3 rounded border px-3"><Label>{t(`reconcile.${key}` as never)}</Label><Switch checked={integration.reconciliation[key]} onCheckedChange={value => patch({ reconciliation: { ...integration.reconciliation, [key]: value } })} /></div>)}
            <div className="min-w-0 space-y-2"><Label>{t("reconcile.interval")}</Label><Input type="number" min={30} max={86400} value={integration.reconciliation.intervalSeconds} onChange={event => patch({ reconciliation: { ...integration.reconciliation, intervalSeconds: Number(event.target.value) } })} /></div>
            <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2 xl:col-span-4">{t("reconcile.safety")}</p>
            <div className="sm:col-span-2 xl:col-span-4"><Button type="button" variant="outline" size="sm" className="w-full sm:w-auto" disabled={busy || !integration.enabled} onClick={() => void run("reconcile")}><RefreshCw className="mr-1 h-4 w-4" />{t("actions.reconcile")}</Button></div>
          </div>
        </MailuSettingsSection>
      </div>
      </div>}
    </section>
  )
}
