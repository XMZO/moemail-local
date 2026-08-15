"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {
  Activity,
  Clock3,
  Globe2,
  KeyRound,
  Loader2,
  Mail,
  ShieldAlert,
  ShieldCheck,
  User2,
  Webhook,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { readApiErrorCode } from "@/lib/api-error-client"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"
import { ROLES } from "@/lib/permissions"

export interface ManagedUser {
  id: string
  name: string | null
  username: string | null
  email: string | null
  image: string | null
  role: string | null
  bannedAt: string | Date | null
  mailboxCount: number
}

interface UserDetailsDialogProps {
  user: ManagedUser | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface UserDetails {
  user: ManagedUser & {
    emailVerified: string | Date | null
    passwordConfigured: boolean
    roles: string[]
    providers: string[]
  }
  summary: {
    mailboxes: number
    activeMailboxes: number
    expiredMailboxes: number
    messages: number
    receivedMessages: number
    sentMessages: number
    apiKeys: number
    enabledApiKeys: number
    webhooks: number
    enabledWebhooks: number
    emailShares: number
    messageShares: number
    quotaEvents: Record<string, number>
  }
  access: {
    permissions: Record<string, boolean>
    quotas: Record<string, number>
    domainAccess: { default: string; domains: Record<string, string> }
    allowedDomains: string[] | null
    quotaRole: string
    roles: string[]
    override: unknown
    mailQuotaRules: Array<{
      id: string
      direction: string
      subject: { type: string; role?: string; userId?: string }
      target: { type: string; domain?: string; address?: string }
      rolling: { limit: number; windowValue: number; windowUnit: string }
      lifetimeLimit: number
      shareWithinRole: boolean
      ignoreEmperor: boolean
    }>
    mailQuotaRuleCount: number
    mailQuotaRulesTruncated: boolean
  }
  mailboxes: {
    items: Array<{
      id: string
      address: string
      createdAt: string | Date
      expiresAt: string | Date
      messageCount: number
      receivedCount: number
      sentCount: number
    }>
    total: number
    page: number
    pageSize: number
    pages: number
  }
  resources: {
    apiKeys: Array<{ id: string; name: string; createdAt: string | Date | null; expiresAt: string | Date | null; enabled: boolean }>
    webhooks: Array<{ id: string; url: string; enabled: boolean; createdAt: string | Date; updatedAt: string | Date }>
    mailboxNameBlocks: Array<{ id: string; localPart: string; domain: string; createdAt: string | Date }>
    mailboxNameBlockCount: number
    mailboxNameBlocksTruncated: boolean
  }
}

const roleKeys: Record<string, string> = {
  [ROLES.EMPEROR]: "EMPEROR",
  [ROLES.DUKE]: "DUKE",
  [ROLES.KNIGHT]: "KNIGHT",
  [ROLES.CIVILIAN]: "CIVILIAN",
}

const quotaKeys = ["maxActiveMailboxes", "maxMailboxLifetimeDays", "maxMessageBytes"] as const

function identityOf(user: ManagedUser) {
  return user.name || user.username || user.email || user.id
}

function dateValue(value: string | Date | null | undefined, format: ReturnType<typeof useFormatter>, fallback: string) {
  return value ? format.dateTime(new Date(value)) : fallback
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string | number }) {
  return <div className="min-w-0 rounded-md border bg-muted/20 p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-4 w-4 shrink-0 text-primary" />{label}</div><div className="mt-1 truncate text-lg font-semibold">{value}</div></div>
}

export function UserDetailsDialog({ user, open, onOpenChange }: UserDetailsDialogProps) {
  const t = useTranslations("profile.promote.details")
  const tRoles = useTranslations("profile.card.roles")
  const tApi = useTranslations("api")
  const format = useFormatter()
  const [details, setDetails] = useState<UserDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [tab, setTab] = useState("overview")
  const [mailboxSearch, setMailboxSearch] = useState("")
  const [mailboxDomain, setMailboxDomain] = useState("")
  const [mailboxStatus, setMailboxStatus] = useState("all")
  const [mailboxPage, setMailboxPage] = useState(1)
  const dialogRef = useRef<HTMLDivElement>(null)
  const tabViewportRef = useRef<HTMLDivElement>(null)
  const activePanelRef = useRef<HTMLDivElement>(null)
  const [tabViewportHeight, setTabViewportHeight] = useState<number | null>(null)

  const fetchDetails = async (signal?: AbortSignal) => {
    if (!user) return
    setLoading(true)
    setError("")
    try {
      const params = new URLSearchParams({
        mailboxPage: mailboxPage.toString(),
        mailboxPageSize: "40",
      })
      if (mailboxSearch.trim()) params.set("mailboxSearch", mailboxSearch.trim())
      if (mailboxDomain.trim()) params.set("mailboxDomain", mailboxDomain.trim())
      if (mailboxStatus !== "all") params.set("mailboxStatus", mailboxStatus)
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}?${params}`, {
        cache: "no-store",
        signal,
      })
      const body = await response.json() as Partial<UserDetails>
      if (!response.ok || !body.user || !body.summary || !body.access || !body.mailboxes || !body.resources) {
        throw new LocalizedUiError(tApi(await readApiErrorCode(response, "USER_DETAILS_READ_FAILED") as never))
      }
      setDetails(body as UserDetails)
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return
      setError(localizedUiErrorMessage(caught, t("loadFailed")))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open || !user) {
      setDetails(null)
      setError("")
      setTabViewportHeight(null)
      return
    }
    setTab("overview")
    setMailboxSearch("")
    setMailboxDomain("")
    setMailboxStatus("all")
    setMailboxPage(1)
  }, [open, user])

  useEffect(() => {
    const nextBannedAt = user?.bannedAt ?? null
    setDetails(previous => previous && previous.user.id === user?.id && previous.user.bannedAt !== nextBannedAt
      ? { ...previous, user: { ...previous.user, bannedAt: nextBannedAt } }
      : previous)
  }, [user?.bannedAt, user?.id])

  useEffect(() => {
    if (!open || !user) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => void fetchDetails(controller.signal), 120)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  // The request is intentionally debounced with the filter state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.id, mailboxSearch, mailboxDomain, mailboxStatus, mailboxPage])

  const permissionEntries = useMemo(() => (
    details ? Object.entries(details.access.permissions) : []
  ), [details])
  const domainEntries = useMemo(() => (
    details ? Object.entries(details.access.domainAccess.domains) : []
  ), [details])

  useLayoutEffect(() => {
    if (!open || !details) return

    const dialog = dialogRef.current
    const viewport = tabViewportRef.current
    const panel = activePanelRef.current
    if (!dialog || !viewport || !panel) return

    const updateHeight = () => {
      const dialogMaximum = window.innerWidth < 640
        ? window.innerHeight - 16
        : Math.min(window.innerHeight * 0.92, 860)
      const chromeHeight = viewport.getBoundingClientRect().top - dialog.getBoundingClientRect().top
      const availableHeight = Math.max(112, dialogMaximum - chromeHeight)
      const nextHeight = Math.ceil(Math.min(panel.scrollHeight, availableHeight))
      setTabViewportHeight(current => current !== null && Math.abs(current - nextHeight) < 1 ? current : nextHeight)
    }

    updateHeight()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateHeight)
    observer?.observe(panel)
    window.addEventListener("resize", updateHeight, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", updateHeight)
    }
  }, [details, error, open, tab])

  useLayoutEffect(() => {
    tabViewportRef.current?.scrollTo({ top: 0 })
  }, [tab])

  const roleLabel = (role: string) => {
    const key = roleKeys[role]
    return key ? tRoles(key as never) : t("notAvailable")
  }
  const statusLabel = details?.user.bannedAt ? t("status.banned") : t("status.active")
  const formatLimit = (key: string, value: number) => {
    if (value === 0) return t("quotas.unlimited")
    if (key === "maxMessageBytes") return format.number(value)
    return format.number(value)
  }
  const ruleSubject = (subject: UserDetails["access"]["mailQuotaRules"][number]["subject"]) => {
    if (subject.type === "role") {
      const role = subject.role && roleKeys[subject.role] ? tRoles(roleKeys[subject.role] as never) : subject.role || t("notAvailable")
      return t("quotaRules.subject.role", { value: role })
    }
    if (subject.type === "user") return t("quotaRules.subject.user")
    return t("quotaRules.subject.all")
  }
  const ruleTarget = (target: UserDetails["access"]["mailQuotaRules"][number]["target"]) => {
    if (target.type === "domain") return t("quotaRules.target.domain", { value: target.domain || t("notAvailable") })
    if (target.type === "mailbox") return t("quotaRules.target.mailbox", { value: target.address || t("notAvailable") })
    return t("quotaRules.target.all")
  }
  const ruleSummary = (rule: UserDetails["access"]["mailQuotaRules"][number]) => {
    const direction = t(`quotaRules.direction.${rule.direction}` as never)
    const limit = rule.rolling.limit === -1 ? t("quotas.unlimited") : format.number(rule.rolling.limit)
    const unit = t(`quotaRules.units.${rule.rolling.windowUnit}` as never)
    const window = t("quotaRules.window", { value: format.number(rule.rolling.windowValue), unit })
    const lifetime = rule.lifetimeLimit >= 0
      ? t("quotaRules.lifetime", { value: format.number(rule.lifetimeLimit) })
      : t("quotaRules.noLifetime")
    return t("quotaRules.summary", {
      direction,
      subject: ruleSubject(rule.subject),
      target: ruleTarget(rule.target),
      limit,
      window,
      lifetime,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={dialogRef} className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(92dvh,860px)] sm:w-[calc(100vw-3rem)]">
        <DialogHeader className="shrink-0 border-b p-4 pr-14 sm:p-6 sm:pr-16">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><User2 className="h-5 w-5" /></div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-left">{user ? identityOf(user) : t("title")}</DialogTitle>
              <DialogDescription className="mt-1 truncate text-left">{user?.email || user?.username || user?.id || t("description")}</DialogDescription>
              {details && <span className={`mt-2 inline-flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-xs ${details.user.bannedAt ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"}`}><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /><span className="truncate">{statusLabel}</span></span>}
            </div>
          </div>
        </DialogHeader>

        {loading && !details ? <div className="flex min-h-56 items-center justify-center gap-2 p-4 text-sm text-muted-foreground sm:p-6"><Loader2 className="h-5 w-5 animate-spin text-primary" />{t("loading")}</div> : error && !details ? <div className="m-4 rounded border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive sm:m-6">{error}</div> : details ? <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <div className="px-4 pt-4 sm:px-6 sm:pt-5">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4"><TabsTrigger className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-center leading-tight" value="overview">{t("tabs.overview")}</TabsTrigger><TabsTrigger className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-center leading-tight" value="mailboxes">{t("tabs.mailboxes")}</TabsTrigger><TabsTrigger className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-center leading-tight" value="access">{t("tabs.access")}</TabsTrigger><TabsTrigger className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-center leading-tight" value="resources">{t("tabs.resources")}</TabsTrigger></TabsList>
          </div>
          {error && <div className="px-4 pt-3 sm:px-6"><p className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</p></div>}
          <div
            ref={tabViewportRef}
            className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable] transition-[height] duration-200 ease-out motion-reduce:transition-none"
            style={tabViewportHeight === null ? undefined : { height: tabViewportHeight }}
          >

            <TabsContent ref={tab === "overview" ? activePanelRef : undefined} value="overview" className="m-0 space-y-4 p-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none sm:p-6">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={Mail} label={t("stats.mailboxes")} value={details.summary.mailboxes} />
                <StatCard icon={Activity} label={t("stats.messages")} value={details.summary.messages} />
                <StatCard icon={KeyRound} label={t("stats.apiKeys")} value={`${details.summary.enabledApiKeys} / ${details.summary.apiKeys}`} />
                <StatCard icon={Webhook} label={t("stats.webhooks")} value={`${details.summary.enabledWebhooks} / ${details.summary.webhooks}`} />
              </div>
              <section className="rounded-md border p-3 sm:p-4">
                <h3 className="flex items-center gap-2 text-sm font-medium"><User2 className="h-4 w-4 text-primary" />{t("identity.title")}</h3>
                <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                  <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t("identity.username")}</dt><dd className="truncate font-mono">{details.user.username || t("notAvailable")}</dd></div>
                  <div className="min-w-0"><dt className="text-xs text-muted-foreground">{t("identity.email")}</dt><dd className="truncate">{details.user.email || t("notAvailable")}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("identity.role")}</dt><dd>{details.user.roles.length ? format.list(details.user.roles.map(roleLabel), { type: "unit" }) : roleLabel(ROLES.CIVILIAN)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("identity.emailVerified")}</dt><dd>{dateValue(details.user.emailVerified, format, t("notAvailable"))}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("identity.providers")}</dt><dd>{details.user.providers.length ? format.list(details.user.providers, { type: "unit" }) : t("identity.passwordOnly")}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("identity.password")}</dt><dd>{details.user.passwordConfigured ? t("identity.configured") : t("identity.notConfigured")}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("identity.status")}</dt><dd>{details.user.bannedAt ? format.list([statusLabel, dateValue(details.user.bannedAt, format, "")], { type: "unit" }) : statusLabel}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t("identity.id")}</dt><dd className="break-all font-mono text-xs">{details.user.id}</dd></div>
                </dl>
              </section>
              <section className="rounded-md border p-3 sm:p-4">
                <h3 className="flex items-center gap-2 text-sm font-medium"><Activity className="h-4 w-4 text-primary" />{t("activity.title")}</h3>
                <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">{t("activity.activeMailboxes")}</span><div className="font-medium">{details.summary.activeMailboxes}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">{t("activity.expiredMailboxes")}</span><div className="font-medium">{details.summary.expiredMailboxes}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">{t("activity.received")}</span><div className="font-medium">{details.summary.receivedMessages}</div></div>
                  <div className="rounded border p-2"><span className="text-xs text-muted-foreground">{t("activity.sent")}</span><div className="font-medium">{details.summary.sentMessages}</div></div>
                </div>
              </section>
            </TabsContent>

            <TabsContent ref={tab === "mailboxes" ? activePanelRef : undefined} value="mailboxes" className="m-0 space-y-3 p-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none sm:p-6">
              <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,.7fr)_10rem]">
                <Input value={mailboxSearch} onChange={event => { setMailboxSearch(event.target.value); setMailboxPage(1) }} placeholder={t("mailboxes.search")} className="min-w-0" />
                <Input value={mailboxDomain} onChange={event => { setMailboxDomain(event.target.value); setMailboxPage(1) }} placeholder={t("mailboxes.domain")} className="min-w-0" />
                <Select value={mailboxStatus} onValueChange={value => { setMailboxStatus(value); setMailboxPage(1) }}><SelectTrigger className="min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("mailboxes.allStatuses")}</SelectItem><SelectItem value="active">{t("mailboxes.active")}</SelectItem><SelectItem value="expired">{t("mailboxes.expired")}</SelectItem></SelectContent></Select>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t("mailboxes.count", { count: details.mailboxes.total })}</span>{loading && <Loader2 className="h-4 w-4 animate-spin" />}</div>
              {details.mailboxes.items.length === 0 ? <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">{t("mailboxes.empty")}</div> : <div className="overflow-hidden rounded-md border">{details.mailboxes.items.map(mailbox => <div key={mailbox.id} className="grid min-w-0 gap-2 border-b p-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"><div className="min-w-0"><div className="truncate font-mono text-sm">{mailbox.address}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{t("mailboxes.created", { value: dateValue(mailbox.createdAt, format, t("notAvailable")) })}</span><span>{t("mailboxes.expires", { value: dateValue(mailbox.expiresAt, format, t("notAvailable")) })}</span></div></div><div className="flex flex-wrap gap-2 text-xs text-muted-foreground sm:justify-end"><span className="rounded bg-muted px-2 py-1">{t("mailboxes.messages", { count: mailbox.messageCount })}</span><span className="rounded bg-muted px-2 py-1">{t("mailboxes.received", { count: mailbox.receivedCount })}</span><span className="rounded bg-muted px-2 py-1">{t("mailboxes.sent", { count: mailbox.sentCount })}</span></div></div>)}</div>}
              {details.mailboxes.pages > 1 && <div className="flex items-center justify-between gap-3 pt-1"><Button size="sm" variant="outline" disabled={mailboxPage <= 1 || loading} onClick={() => setMailboxPage(page => Math.max(1, page - 1))}>{t("mailboxes.previous")}</Button><span className="text-xs text-muted-foreground">{t("mailboxes.page", { current: details.mailboxes.page, total: details.mailboxes.pages })}</span><Button size="sm" variant="outline" disabled={mailboxPage >= details.mailboxes.pages || loading} onClick={() => setMailboxPage(page => page + 1)}>{t("mailboxes.next")}</Button></div>}
            </TabsContent>

            <TabsContent ref={tab === "access" ? activePanelRef : undefined} value="access" className="m-0 space-y-4 p-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none sm:p-6">
              <section className="rounded-md border p-3 sm:p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="h-4 w-4 text-primary" />{t("access.permissions")}</h3><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{permissionEntries.map(([permission, enabled]) => <div key={permission} className={`flex min-w-0 items-center gap-2 rounded border p-2 text-sm ${enabled ? "" : "opacity-55"}`}><span className={`h-2 w-2 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`} /><span className="min-w-0 break-words">{t(`permissions.${permission}` as never)}</span></div>)}</div></section>
              <section className="rounded-md border p-3 sm:p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><Clock3 className="h-4 w-4 text-primary" />{t("access.quotas")}</h3><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded bg-muted px-2 py-1">{t("access.quotaRole", { role: roleLabel(details.access.quotaRole) })}</span>{Boolean(details.access.override) && <span className="rounded bg-primary/10 px-2 py-1 text-primary">{t("access.overrideActive")}</span>}</div><div className="mt-3 grid gap-2 sm:grid-cols-3">{quotaKeys.map(key => <div key={key} className="rounded border p-2"><div className="text-xs text-muted-foreground">{t(`quotas.${key}` as never)}</div><div className="mt-1 font-medium">{formatLimit(key, details.access.quotas[key] ?? 0)}</div></div>)}</div><p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t("access.quotaRules", { count: details.access.mailQuotaRuleCount })}{details.access.mailQuotaRulesTruncated && <span className="ml-1">{t("access.quotaRulesTruncated")}</span>}</p></section>
              <section className="rounded-md border p-3 sm:p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><Globe2 className="h-4 w-4 text-primary" />{t("access.domains")}</h3><p className="mt-2 text-sm">{t(`domainModes.${details.access.domainAccess.default}` as never)}</p>{domainEntries.length > 0 && <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{domainEntries.map(([domain, mode]) => <div key={domain} className="flex min-w-0 items-center justify-between gap-2 rounded border p-2 text-xs"><span className="min-w-0 truncate font-mono">{domain}</span><span className="shrink-0 text-muted-foreground">{t(`domainModes.${mode}` as never)}</span></div>)}</div>}{details.access.allowedDomains && <p className="mt-3 text-xs text-muted-foreground">{t("access.allowedDomains", { domains: details.access.allowedDomains.length ? format.list(details.access.allowedDomains, { type: "unit" }) : t("none") })}</p>}</section>
              <details className="rounded-md border p-3 sm:p-4"><summary className="cursor-pointer text-sm font-medium">{t("access.quotaRules", { count: details.access.mailQuotaRuleCount })}</summary><div className="mt-3 space-y-2">{details.access.mailQuotaRules.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : details.access.mailQuotaRules.map(rule => <div key={rule.id} className="rounded border p-2 text-xs"><p className="break-words leading-relaxed">{ruleSummary(rule)}</p><div className="mt-2 flex flex-wrap gap-1.5">{rule.shareWithinRole && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">{t("quotaRules.shared")}</span>}{rule.ignoreEmperor && <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{t("quotaRules.ignoreEmperor")}</span>}</div></div>)}</div>{details.access.mailQuotaRulesTruncated && <p className="mt-2 text-xs text-muted-foreground">{t("access.quotaRulesTruncated")}</p>}</details>
            </TabsContent>

            <TabsContent ref={tab === "resources" ? activePanelRef : undefined} value="resources" className="m-0 space-y-4 p-4 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none sm:p-6">
              <section className="rounded-md border p-3 sm:p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4 text-primary" />{t("resources.apiKeys")}</h3>{details.resources.apiKeys.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t("resources.none")}</p> : <div className="mt-3 space-y-2">{details.resources.apiKeys.map(key => <div key={key.id} className="grid min-w-0 gap-1 rounded border p-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"><span className="truncate">{key.name}</span><span className="text-xs text-muted-foreground sm:text-right">{key.enabled ? t("resources.enabled") : t("resources.disabled")} · {dateValue(key.expiresAt, format, t("resources.neverExpires"))}</span></div>)}</div>}</section>
              <section className="rounded-md border p-3 sm:p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><Webhook className="h-4 w-4 text-primary" />{t("resources.webhooks")}</h3>{details.resources.webhooks.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t("resources.none")}</p> : <div className="mt-3 space-y-2">{details.resources.webhooks.map(webhook => <div key={webhook.id} className="grid min-w-0 gap-1 rounded border p-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"><span className="truncate font-mono text-xs">{webhook.url}</span><span className="text-xs text-muted-foreground sm:text-right">{webhook.enabled ? t("resources.enabled") : t("resources.disabled")}</span></div>)}</div>}</section>
              <section className="rounded-md border p-3 sm:p-4"><h3 className="flex items-center gap-2 text-sm font-medium"><ShieldAlert className="h-4 w-4 text-primary" />{t("resources.blocks")}</h3>{details.resources.mailboxNameBlocks.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">{t("resources.none")}</p> : <div className="mt-3 flex flex-wrap gap-2">{details.resources.mailboxNameBlocks.map(block => <span key={block.id} className="rounded bg-muted px-2 py-1 font-mono text-xs">{block.localPart}@{block.domain}</span>)}</div>}{details.resources.mailboxNameBlocksTruncated && <p className="mt-3 text-xs text-muted-foreground">{t("resources.truncated", { shown: details.resources.mailboxNameBlocks.length, total: details.resources.mailboxNameBlockCount })}</p>}</section>
            </TabsContent>
          </div>
        </Tabs> : null}
      </DialogContent>
    </Dialog>
  )
}
