"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, Globe2, Loader2, PlugZap, Plus, RotateCcw, Save, Trash2 } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/components/ui/use-toast"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"
import { SecretInput } from "@/components/ui/secret-input"
import { MailuIntegrationPanel } from "@/components/profile/mailu-integration-panel"
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

type Inbound =
  | { mode: "worker" }
  | { mode: "mailu" }
  | { mode: "disabled" }
  | {
      mode: "imap"
      host: string
      port: number
      security: "plain" | "starttls" | "tls"
      username: string
      password: string
      rejectUnauthorized: boolean
      mailbox: string
      recipientHeader: "auto" | "x-original-to" | "delivered-to" | "envelope-to" | "x-envelope-to"
      initialSync: "new" | "unseen"
      connectionTimeoutSeconds: number
      realtime: {
        enabled: boolean
        mode: "idle"
        reconnect: boolean
        idleRenewSeconds: number
        reconnectMinSeconds: number
        reconnectMaxSeconds: number
      }
      pollIntervalSeconds: number
      maxMessagesPerPoll: number
    }
type Outbound =
  | { mode: "disabled" }
  | { mode: "mailu" }
  | { mode: "resend"; apiKey: string; fromName: string | null }
  | {
      mode: "smtp"
      host: string
      port: number
      security: "plain" | "starttls" | "tls"
      authMethod: "auto" | "plain" | "login"
      username: string | null
      password: string | null
      rejectUnauthorized: boolean
      fromName: string | null
    }

interface DomainPolicy {
  domain: string
  inbound: Inbound
  outbound: Outbound
}

const freshPolicy = (domain = "example.com"): DomainPolicy => ({
  domain,
  inbound: { mode: "worker" },
  outbound: { mode: "disabled" },
})

const smtpDefaults = (): Extract<Outbound, { mode: "smtp" }> => ({
  mode: "smtp",
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  authMethod: "auto",
  username: null,
  password: null,
  rejectUnauthorized: true,
  fromName: null,
})

const imapDefaults = (): Extract<Inbound, { mode: "imap" }> => ({
  mode: "imap",
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "",
  password: "",
  rejectUnauthorized: true,
  mailbox: "INBOX",
  recipientHeader: "auto",
  initialSync: "new",
  connectionTimeoutSeconds: 15,
  realtime: {
    enabled: true,
    mode: "idle",
    reconnect: true,
    idleRenewSeconds: 1_500,
    reconnectMinSeconds: 1,
    reconnectMaxSeconds: 30,
  },
  pollIntervalSeconds: 60,
  maxMessagesPerPoll: 100,
})

export function DomainPolicyPanel({ canManageConfig, canManageMailu }: {
  canManageConfig: boolean
  canManageMailu: boolean
}) {
  const format = useFormatter()
  const t = useTranslations("domains")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const [policies, setPolicies] = useState<DomainPolicy[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingImap, setTestingImap] = useState(false)
  const [testingSmtp, setTestingSmtp] = useState(false)
  const [error, setError] = useState("")
  const [deleteDomain, setDeleteDomain] = useState<string | null>(null)
  const { toast } = useToast()

  const load = useCallback(async () => {
    if (!canManageConfig) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/config/domains", { cache: "no-store" })
      const body = await response.clone().json() as { policies?: DomainPolicy[]; error?: string }
      if (!response.ok || !body.policies) {
        const code = await readApiErrorCode(response, "DOMAIN_POLICIES_READ_FAILED")
        throw new LocalizedUiError(tApi.has(code as never) ? tApi(code as never) : t("errors.load"))
      }
      setPolicies(body.policies)
      setSelected(index => Math.min(index, Math.max(0, body.policies!.length - 1)))
    } catch (caught) {
      console.error("domain_policy.load_failed", caught)
      setError(t("errors.load"))
    } finally {
      setLoading(false)
    }
  }, [canManageConfig, t, tApi])

  useEffect(() => { void load() }, [load])

  const current = policies[selected]
  const updateCurrent = (update: (policy: DomainPolicy) => DomainPolicy) => {
    setPolicies(previous => previous.map((policy, index) => index === selected ? update(policy) : policy))
  }

  const setOutboundMode = (mode: Outbound["mode"]) => {
    updateCurrent(policy => ({
      ...policy,
      outbound: mode === "disabled"
        ? { mode: "disabled" }
        : mode === "resend"
          ? { mode: "resend", apiKey: "", fromName: null }
          : mode === "mailu"
            ? { mode: "mailu" }
            : smtpDefaults(),
    }))
  }

  const setInboundMode = (mode: Inbound["mode"]) => {
    updateCurrent(policy => ({
      ...policy,
      inbound: mode === "imap" ? imapDefaults() : { mode },
    }))
  }

  const testImap = async () => {
    if (!current || current.inbound.mode !== "imap") return
    setTestingImap(true)
    setError("")
    try {
      const response = await fetch("/api/config/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "imap", policy: current.inbound }),
      })
      const body = await response.json() as { error?: string; code?: string; mailbox?: string; messages?: number; idleSupported?: boolean }
      if (!response.ok) {
        const code = body.code ?? body.error ?? "IMAP_CONNECTION_FAILED"
        throw new LocalizedUiError(tApi.has(code as never) ? tApi(code as never) : t("errors.imapTest"))
      }
      toast({
        title: t("success.imapTitle"),
        description: t("success.imapDescription", {
          mailbox: body.mailbox ?? "INBOX",
          messages: body.messages ?? 0,
          capability: t(body.idleSupported ? "imap.capabilityIdle" : "imap.capabilityPolling"),
        }),
      })
    } catch (caught) {
      console.error("domain_policy.imap_test_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.imapTest")))
    } finally {
      setTestingImap(false)
    }
  }

  const testSmtp = async () => {
    if (!current || current.outbound.mode !== "smtp") return
    setTestingSmtp(true)
    setError("")
    try {
      const response = await fetch("/api/config/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "smtp", policy: current.outbound }),
      })
      if (!response.ok) {
        const code = await readApiErrorCode(response, "SMTP_CONNECTION_FAILED")
        throw new LocalizedUiError(tApi.has(code as never) ? tApi(code as never) : t("errors.smtpTest"))
      }
      toast({ title: t("success.smtpTitle") })
    } catch (caught) {
      console.error("domain_policy.smtp_test_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.smtpTest")))
    } finally {
      setTestingSmtp(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/config/domains", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policies }),
      })
      const body = await response.json() as {
        policies?: DomainPolicy[]
        error?: string
        issues?: Array<{ path: string; code?: string }>
      }
      if (!response.ok || !body.policies) {
        const paths = body.issues?.map(issue => issue.path).filter(Boolean) ?? []
        const code = body.error ?? "DOMAIN_POLICIES_SAVE_FAILED"
        const translated = tApi.has(code as never) ? tApi(code as never) : t("errors.save")
        throw new LocalizedUiError(paths.length > 0
          ? tFormat("labelValue", {
            label: translated,
            value: format.list(paths, { type: "unit" }),
          })
          : translated)
      }
      setPolicies(body.policies)
      toast({ title: t("success.saved") })
    } catch (caught) {
      console.error("domain_policy.save_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.save")))
    } finally {
      setSaving(false)
    }
  }

  const addDomain = () => {
    const suffix = policies.length + 1
    setPolicies(previous => [...previous, freshPolicy(`mail${suffix}.example.com`)])
    setSelected(policies.length)
  }

  const addMailuDomains = (domains: string[]) => {
    setPolicies(previous => {
      const existing = new Set(previous.map(policy => policy.domain))
      return [...previous, ...domains.filter(domain => !existing.has(domain)).map(domain => ({
        domain,
        inbound: { mode: "mailu" as const },
        outbound: { mode: "mailu" as const },
      }))]
    })
    toast({ title: t("mailu.success.domainsAdded", { count: domains.filter(domain => !policies.some(policy => policy.domain === domain)).length }) })
  }

  const removeCurrent = () => {
    if (policies.length <= 1) return
    setPolicies(previous => previous.filter((_, index) => index !== selected))
    setSelected(index => Math.max(0, index - 1))
    setDeleteDomain(null)
  }

  const modeSummary = useMemo(() => current
    ? t("summary", {
      inbound: t(`inboundModes.${current.inbound.mode}` as never),
      outbound: t(`outboundModes.${current.outbound.mode}` as never),
    })
    : "",
  [current, t])

  if (loading) {
    return <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
  }

  return (
    <div className="space-y-4">
      {canManageMailu && <MailuIntegrationPanel canImportDomains={canManageConfig} onDomainsDiscovered={addMailuDomains} />}
      {canManageConfig && (
      <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold"><Globe2 className="h-5 w-5 text-primary" />{t("title")}</div>
          <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addDomain}><Plus className="mr-1 h-4 w-4" />{t("add")}</Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving}><Save className="mr-1 h-4 w-4" />{saving ? t("saving") : t("save")}</Button>
        </div>
      </div>

      {error && <div className="mb-4 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {current && (
        <>
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
            {policies.map((policy, index) => (
              <Button
                key={`${policy.domain}-${index}`}
                type="button"
                size="sm"
                variant={selected === index ? "default" : "outline"}
                className="shrink-0"
                onClick={() => setSelected(index)}
              >
                {policy.domain}
              </Button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="space-y-4 rounded-md border p-4">
              <div className="flex items-center justify-between gap-2">
                <div><h3 className="font-medium">{t("domainInbound")}</h3><p className="text-xs text-muted-foreground">{modeSummary}</p></div>
                <Button type="button" variant="ghost" size="icon" onClick={() => setDeleteDomain(current.domain)} disabled={policies.length <= 1} title={t("deleteDomain")}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <div className="space-y-2">
                <Label>{t("domain")}</Label>
                <Input value={current.domain} onChange={event => updateCurrent(policy => ({ ...policy, domain: event.target.value }))} spellCheck={false} />
              </div>
              <div className="space-y-2">
                <Label>{t("inboundMode")}</Label>
                <Select value={current.inbound.mode} onValueChange={mode => setInboundMode(mode as Inbound["mode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="worker">{t("inboundModes.worker")}</SelectItem>
                    <SelectItem value="imap">{t("inboundModes.imap")}</SelectItem>
                    <SelectItem value="mailu">{t("inboundModes.mailu")}</SelectItem>
                    <SelectItem value="disabled">{t("inboundModes.disabled")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {current.inbound.mode === "imap" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2 rounded-md border bg-muted/20 p-2.5 sm:col-span-2 sm:grid-cols-2">
                    <div className="flex min-h-10 items-center justify-between gap-3 rounded border bg-background px-3 py-2">
                      <Label htmlFor="domain-imap-realtime">{t("imap.realtimeEnabled")}</Label>
                      <Switch
                        id="domain-imap-realtime"
                        checked={current.inbound.realtime.enabled}
                        onCheckedChange={enabled => updateCurrent(policy => ({
                          ...policy,
                          inbound: {
                            ...(policy.inbound as Extract<Inbound, { mode: "imap" }>),
                            realtime: {
                              ...(policy.inbound as Extract<Inbound, { mode: "imap" }>).realtime,
                              enabled,
                            },
                          },
                        }))}
                      />
                    </div>
                    <div className="flex min-h-10 items-center justify-between gap-3 rounded border bg-background px-3 py-2">
                      <Label>{t("imap.realtimeMode")}</Label>
                      <span className="max-w-[13rem] text-right text-xs leading-tight text-muted-foreground">
                        {t("imap.modeIdleAuto")}
                      </span>
                    </div>
                    <div className="flex min-h-10 items-center justify-between gap-3 rounded border bg-background px-3 py-2">
                      <Label htmlFor="domain-imap-reconnect">{t("imap.reconnect")}</Label>
                      <Switch
                        id="domain-imap-reconnect"
                        disabled={!current.inbound.realtime.enabled}
                        checked={current.inbound.realtime.reconnect}
                        onCheckedChange={reconnect => updateCurrent(policy => ({
                          ...policy,
                          inbound: {
                            ...(policy.inbound as Extract<Inbound, { mode: "imap" }>),
                            realtime: {
                              ...(policy.inbound as Extract<Inbound, { mode: "imap" }>).realtime,
                              reconnect,
                            },
                          },
                        }))}
                      />
                    </div>
                    <div className="grid min-h-10 gap-2 rounded border bg-background px-3 py-2 sm:grid-cols-[minmax(0,1fr)_6rem] sm:items-center">
                      <Label htmlFor="domain-imap-fallback">{t("imap.fallbackPollInterval")}</Label>
                      <Input
                        id="domain-imap-fallback"
                        className="h-8"
                        type="number"
                        min={15}
                        max={86400}
                        value={current.inbound.pollIntervalSeconds}
                        onChange={event => updateCurrent(policy => ({
                          ...policy,
                          inbound: {
                            ...(policy.inbound as Extract<Inbound, { mode: "imap" }>),
                            pollIntervalSeconds: Number(event.target.value),
                          },
                        }))}
                      />
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t("imap.realtimeHelp")}
                    </p>
                  </div>
                  <div className="space-y-2"><Label>{t("imap.host")}</Label><Input value={current.inbound.host} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), host: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>{t("common.port")}</Label><Input type="number" min={1} max={65535} value={current.inbound.port} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), port: Number(event.target.value) } }))} /></div>
                  <div className="space-y-2"><Label>{t("common.security")}</Label><Select value={current.inbound.security} onValueChange={security => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), security: security as "plain" | "starttls" | "tls" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tls">{t("common.securityOptions.tls993")}</SelectItem><SelectItem value="starttls">{t("common.securityOptions.starttls143")}</SelectItem><SelectItem value="plain">{t("common.securityOptions.plain")}</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>{t("imap.mailbox")}</Label><Input value={current.inbound.mailbox} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), mailbox: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>{t("common.username")}</Label><Input autoComplete="username" value={current.inbound.username} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), username: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>{t("imap.password")}</Label><SecretInput showLabel={t("secrets.show")} hideLabel={t("secrets.hide")} autoComplete="new-password" value={current.inbound.password} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), password: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>{t("imap.recipientHeader")}</Label><Select value={current.inbound.recipientHeader} onValueChange={recipientHeader => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), recipientHeader: recipientHeader as Extract<Inbound, { mode: "imap" }>["recipientHeader"] } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">{t("imap.recipientHeaders.auto")}</SelectItem><SelectItem value="x-original-to">{t("imap.recipientHeaders.xOriginalTo")}</SelectItem><SelectItem value="delivered-to">{t("imap.recipientHeaders.deliveredTo")}</SelectItem><SelectItem value="envelope-to">{t("imap.recipientHeaders.envelopeTo")}</SelectItem><SelectItem value="x-envelope-to">{t("imap.recipientHeaders.xEnvelopeTo")}</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>{t("imap.initialSync")}</Label><Select value={current.inbound.initialSync} onValueChange={initialSync => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), initialSync: initialSync as "new" | "unseen" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="new">{t("imap.initialSyncOptions.new")}</SelectItem><SelectItem value="unseen">{t("imap.initialSyncOptions.unseen")}</SelectItem></SelectContent></Select></div>
                  <div className="flex items-center justify-between gap-3 rounded border p-3 sm:col-span-2"><div><Label>{t("common.strictCertificate")}</Label><p className="text-xs text-muted-foreground">{t("imap.certificateHelp")}</p></div><Switch checked={current.inbound.rejectUnauthorized} onCheckedChange={rejectUnauthorized => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), rejectUnauthorized } }))} /></div>
                  <details className="group overflow-hidden rounded border bg-muted/20 sm:col-span-2">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                      <span>{t("imap.advanced")}</span>
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
                    </summary>
                    <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-2">
                        <Label>{t("imap.connectionTimeout")}</Label>
                        <Input type="number" min={5} max={120} value={current.inbound.connectionTimeoutSeconds} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), connectionTimeoutSeconds: Number(event.target.value) } }))} />
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Label>{t("imap.idleRenew")}</Label>
                        <Input disabled={!current.inbound.realtime.enabled} type="number" min={60} max={1740} value={current.inbound.realtime.idleRenewSeconds} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), realtime: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>).realtime, idleRenewSeconds: Number(event.target.value) } } }))} />
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Label>{t("imap.reconnectMin")}</Label>
                        <Input disabled={!current.inbound.realtime.enabled || !current.inbound.realtime.reconnect} type="number" min={1} max={60} value={current.inbound.realtime.reconnectMinSeconds} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), realtime: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>).realtime, reconnectMinSeconds: Number(event.target.value) } } }))} />
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Label>{t("imap.reconnectMax")}</Label>
                        <Input disabled={!current.inbound.realtime.enabled || !current.inbound.realtime.reconnect} type="number" min={5} max={300} value={current.inbound.realtime.reconnectMaxSeconds} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), realtime: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>).realtime, reconnectMaxSeconds: Number(event.target.value) } } }))} />
                      </div>
                      <div className="min-w-0 space-y-2 sm:col-span-2">
                        <Label>{t("imap.maxMessages")}</Label>
                        <Input type="number" min={1} max={1000} value={current.inbound.maxMessagesPerPoll} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), maxMessagesPerPoll: Number(event.target.value) } }))} />
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">{t("imap.advancedHelp")}</p>
                    </div>
                  </details>
                  <div className="sm:col-span-2"><Button type="button" variant="outline" size="sm" onClick={() => void testImap()} disabled={testingImap}><PlugZap className="mr-1 h-4 w-4" />{testingImap ? t("imap.testing") : t("imap.test")}</Button></div>
                  <p className="text-xs text-muted-foreground sm:col-span-2">{t("imap.readOnlyHelp")}</p>
                </div>
              )}
              {current.inbound.mode === "mailu" && <p className="rounded border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">{t("mailu.domainHelp")}</p>}
              <Button type="button" variant="outline" size="sm" onClick={() => updateCurrent(() => freshPolicy(current.domain))}>
                <RotateCcw className="mr-1 h-4 w-4" />{t("resetDomain")}
              </Button>
            </section>

            <section className="space-y-4 rounded-md border p-4">
              <div><h3 className="font-medium">{t("outbound")}</h3><p className="text-xs text-muted-foreground">{t("outboundDescription")}</p></div>
              <div className="space-y-2">
                <Label>{t("outboundMode")}</Label>
                <Select value={current.outbound.mode} onValueChange={mode => setOutboundMode(mode as Outbound["mode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="resend">{t("outboundModes.resend")}</SelectItem>
                    <SelectItem value="smtp">{t("outboundModes.smtp")}</SelectItem>
                    <SelectItem value="mailu">{t("outboundModes.mailu")}</SelectItem>
                    <SelectItem value="disabled">{t("outboundModes.disabled")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {current.outbound.mode === "resend" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2"><Label>{t("resendApiKey")}</Label><SecretInput showLabel={t("secrets.show")} hideLabel={t("secrets.hide")} autoComplete="new-password" value={current.outbound.apiKey} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "resend" }>), apiKey: event.target.value } }))} /></div>
                  <div className="space-y-2 sm:col-span-2"><Label>{t("smtp.fromName")}</Label><Input value={current.outbound.fromName ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "resend" }>), fromName: event.target.value || null } }))} /></div>
                </div>
              )}

              {current.outbound.mode === "smtp" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label>{t("smtp.host")}</Label><Input value={current.outbound.host} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), host: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>{t("common.port")}</Label><Input type="number" min={1} max={65535} value={current.outbound.port} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), port: Number(event.target.value) } }))} /></div>
                  <div className="space-y-2"><Label>{t("common.security")}</Label><Select value={current.outbound.security} onValueChange={security => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), security: security as "plain" | "starttls" | "tls" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="starttls">{t("common.securityOptions.starttls")}</SelectItem><SelectItem value="tls">{t("common.securityOptions.tls")}</SelectItem><SelectItem value="plain">{t("common.securityOptions.plain")}</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>{t("smtp.authMethod")}</Label><Select value={current.outbound.authMethod} onValueChange={authMethod => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), authMethod: authMethod as "auto" | "plain" | "login" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">{t("smtp.authMethods.auto")}</SelectItem><SelectItem value="plain">{t("smtp.authMethods.plain")}</SelectItem><SelectItem value="login">{t("smtp.authMethods.login")}</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>{t("smtp.fromName")}</Label><Input value={current.outbound.fromName ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), fromName: event.target.value || null } }))} /></div>
                  <div className="space-y-2"><Label>{t("smtp.username")}</Label><Input value={current.outbound.username ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), username: event.target.value || null } }))} /></div>
                  <div className="space-y-2"><Label>{t("smtp.password")}</Label><SecretInput showLabel={t("secrets.show")} hideLabel={t("secrets.hide")} autoComplete="new-password" value={current.outbound.password ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), password: event.target.value || null } }))} /></div>
                  <div className="flex items-center justify-between gap-3 rounded border p-3 sm:col-span-2"><div><Label>{t("common.strictCertificate")}</Label><p className="text-xs text-muted-foreground">{t("smtp.certificateHelp")}</p></div><Switch checked={current.outbound.rejectUnauthorized} onCheckedChange={rejectUnauthorized => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), rejectUnauthorized } }))} /></div>
                  <div className="sm:col-span-2"><Button type="button" variant="outline" size="sm" onClick={() => void testSmtp()} disabled={testingSmtp}><PlugZap className="mr-1 h-4 w-4" />{testingSmtp ? t("smtp.testing") : t("smtp.test")}</Button></div>
                </div>
              )}
              {current.outbound.mode === "mailu" && <p className="rounded border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">{t("mailu.senderSafety")}</p>}
            </section>
          </div>
        </>
      )}
      <AlertDialog open={deleteDomain !== null} onOpenChange={open => { if (!open) setDeleteDomain(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteConfirm.description", { domain: deleteDomain ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteConfirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={removeCurrent}>{t("deleteConfirm.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
      )}
    </div>
  )
}
