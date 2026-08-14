"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowRight, BarChart3, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { normalizeMailboxCreationName } from "@/lib/email-address"
import { ROLES, type Role } from "@/lib/permissions"
import { SearchableUserSelect, type SearchableUser } from "./searchable-user-select"

export type MailDirection = "send" | "receive"
export type MailQuotaUnit = "second" | "minute" | "hour" | "day" | "week" | "month"
export type MailQuotaRule = { limit: number; windowValue: number; windowUnit: MailQuotaUnit }
export type MailQuotaSubject = { type: "all" } | { type: "role"; role: Role } | { type: "user"; userId: string }
export type MailQuotaTarget = { type: "all" } | { type: "domain"; domain: string } | { type: "mailbox"; address: string }
export type MailQuotaAssignment = {
  id: string
  direction: MailDirection
  subject: MailQuotaSubject
  target: MailQuotaTarget
  rolling: MailQuotaRule
  lifetimeLimit: number
  shareWithinRole: boolean
  ignoreEmperor: boolean
}
export type MailQuotaCounter = {
  rule: MailQuotaRule
  completed: number
  pending: number
  used: number
  remaining: number | null
}
export type AppliedMailQuotaCounter = {
  assignment: MailQuotaAssignment
  rolling: MailQuotaCounter
  lifetimeCompleted: number
  lifetimePending: number
  lifetimeUsed: number
  lifetimeRemaining: number | null
}
export type MailQuotaUsage = {
  direction: MailDirection
  aggregate: boolean
  allTimeCompleted: number
  rules: AppliedMailQuotaCounter[]
}
export type QuotaUser = {
  id: string
  name: string | null
  username: string | null
  email: string | null
  role: string | null
}

const units: MailQuotaUnit[] = ["second", "minute", "hour", "day", "week", "month"]
const roles = [ROLES.EMPEROR, ROLES.DUKE, ROLES.KNIGHT, ROLES.CIVILIAN] as const
const roleTranslationKeys = { emperor: "EMPEROR", duke: "DUKE", knight: "KNIGHT", civilian: "CIVILIAN" } as const
const compactSelectTrigger = "h-8 min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"

function subjectKey(subject: MailQuotaSubject) {
  return subject.type === "all" ? "all" : subject.type === "role" ? `role:${subject.role}` : `user:${subject.userId}`
}

function targetKey(target: MailQuotaTarget) {
  return target.type === "all" ? "all" : target.type === "domain" ? `domain:${target.domain}` : `mailbox:${target.address}`
}

function assignmentKey(assignment: Pick<MailQuotaAssignment, "direction" | "subject" | "target">) {
  return `${assignment.direction}|${subjectKey(assignment.subject)}|${targetKey(assignment.target)}`
}

export function MailQuotaRuleFields({ id, rule, onChange }: {
  id: string
  rule: MailQuotaRule
  onChange: (value: MailQuotaRule) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  return (
    <div className="grid min-w-0 gap-2 min-[520px]:grid-cols-[minmax(5rem,.7fr)_minmax(5rem,.6fr)_minmax(7.5rem,1fr)]">
      <div className="min-w-0 space-y-1"><Label htmlFor={`${id}-limit`} className="text-xs">{t("limit")}</Label><Input id={`${id}-limit`} className="h-8 min-w-0" type="number" min={-1} max={1_000_000_000} value={rule.limit} onChange={event => onChange({ ...rule, limit: Number(event.target.value) })} /></div>
      <div className="min-w-0 space-y-1"><Label htmlFor={`${id}-window`} className="text-xs">{t("every")}</Label><Input id={`${id}-window`} className="h-8 min-w-0" type="number" min={1} max={100_000} value={rule.windowValue} onChange={event => onChange({ ...rule, windowValue: Number(event.target.value) })} /></div>
      <div className="min-w-0 space-y-1"><Label className="text-xs">{t("unit")}</Label><Select value={rule.windowUnit} onValueChange={windowUnit => onChange({ ...rule, windowUnit: windowUnit as MailQuotaUnit })}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent>{units.map(unit => <SelectItem key={unit} value={unit}>{t(`units.${unit}` as never)}</SelectItem>)}</SelectContent></Select></div>
    </div>
  )
}

function identity(user: QuotaUser) {
  return user.name || user.username || user.email || user.id
}

function QuotaToggle({ checked, onChange, label, help }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  help?: string
}) {
  return (
    <label className="grid min-w-0 cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2 rounded-md bg-muted/30 p-2.5 text-xs">
      <Checkbox className="mt-0.5" checked={checked} onChange={onChange} />
      <span className="min-w-0 leading-relaxed [overflow-wrap:anywhere]">
        <span className="font-medium text-foreground">{label}</span>
        {help && <span className="mt-0.5 block text-muted-foreground">{help}</span>}
      </span>
    </label>
  )
}

export function MailQuotaRuleEditor({ rules, domains, users, onChange, onUserResolved }: {
  rules: MailQuotaAssignment[]
  domains: string[]
  users: QuotaUser[]
  onChange: (rules: MailQuotaAssignment[]) => void
  onUserResolved?: (user: SearchableUser) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  const tRoles = useTranslations("profile.card.roles")
  const [direction, setDirection] = useState<MailDirection>("send")
  const [subjectType, setSubjectType] = useState<MailQuotaSubject["type"]>("all")
  const [subjectRole, setSubjectRole] = useState<Role>(ROLES.DUKE)
  const [subjectUserId, setSubjectUserId] = useState("")
  const [targetType, setTargetType] = useState<MailQuotaTarget["type"]>("all")
  const [targetDomain, setTargetDomain] = useState("")
  const [mailboxLocalPart, setMailboxLocalPart] = useState("")
  const [rolling, setRolling] = useState<MailQuotaRule>({ limit: -1, windowValue: 1, windowUnit: "day" })
  const [lifetimeLimit, setLifetimeLimit] = useState(-1)
  const [shareWithinRole, setShareWithinRole] = useState(false)
  const [ignoreEmperor, setIgnoreEmperor] = useState(false)
  const visibleRules = useMemo(() => rules.filter(rule => rule.direction === direction), [direction, rules])
  const mailboxName = normalizeMailboxCreationName(mailboxLocalPart)
  const mailboxDomain = targetDomain || domains[0] || ""
  const subject: MailQuotaSubject = subjectType === "all"
    ? { type: "all" }
    : subjectType === "role" ? { type: "role", role: subjectRole } : { type: "user", userId: subjectUserId }
  const target: MailQuotaTarget = targetType === "all"
    ? { type: "all" }
    : targetType === "domain" ? { type: "domain", domain: targetDomain || domains[0] || "" } : { type: "mailbox", address: `${mailboxName}@${mailboxDomain}` }
  const draft = { direction, subject, target }
  const duplicate = rules.some(rule => assignmentKey(rule) === assignmentKey(draft))
  const valid = (subjectType !== "user" || Boolean(subjectUserId))
    && (targetType === "all" || Boolean(mailboxDomain))
    && (targetType !== "mailbox" || Boolean(mailboxName))
    && Number.isSafeInteger(rolling.limit) && rolling.limit >= -1
    && Number.isSafeInteger(rolling.windowValue) && rolling.windowValue >= 1
    && (targetType !== "mailbox" || (Number.isSafeInteger(lifetimeLimit) && lifetimeLimit >= -1))

  const subjectLabel = (value: MailQuotaSubject) => value.type === "all"
    ? t("subjects.all")
    : value.type === "role"
      ? t("subjects.roleValue", { role: tRoles(roleTranslationKeys[value.role]) })
      : t("subjects.userValue", { user: identity(users.find(user => user.id === value.userId) ?? { id: value.userId, name: null, username: null, email: null, role: null }) })
  const targetLabel = (value: MailQuotaTarget) => value.type === "all"
    ? t("targets.all")
    : value.type === "domain" ? t("targets.domainValue", { domain: value.domain }) : t("targets.mailboxValue", { address: value.address })
  const updateRule = (id: string, patch: Partial<MailQuotaAssignment>) => onChange(rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule))

  return (
    <section className="space-y-4">
      <div><h3 className="text-sm font-medium">{t("title")}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("help")}</p></div>
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground"><p>{t("precedence")}</p><p className="mt-1">{t("independent")}</p></div>
      <Tabs value={direction} onValueChange={value => setDirection(value as MailDirection)}><TabsList className="flex h-auto w-full min-[420px]:w-auto"><TabsTrigger className="min-w-0 flex-1 min-[420px]:flex-none" value="send">{t("directions.send")}</TabsTrigger><TabsTrigger className="min-w-0 flex-1 min-[420px]:flex-none" value="receive">{t("directions.receive")}</TabsTrigger></TabsList></Tabs>
      <div className="min-w-0 space-y-3 rounded-md border p-3">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label className="text-xs">{t("subject")}</Label>
            <div className="grid min-w-0 gap-2 md:grid-cols-2"><Select value={subjectType} onValueChange={value => setSubjectType(value as MailQuotaSubject["type"])}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("subjects.all")}</SelectItem><SelectItem value="role">{t("subjects.role")}</SelectItem><SelectItem value="user">{t("subjects.user")}</SelectItem></SelectContent></Select>{subjectType === "role" ? <Select value={subjectRole} onValueChange={value => setSubjectRole(value as Role)}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent>{roles.map(role => <SelectItem key={role} value={role}>{tRoles(roleTranslationKeys[role])}</SelectItem>)}</SelectContent></Select> : subjectType === "user" ? <SearchableUserSelect value={subjectUserId} onValueChange={setSubjectUserId} knownUsers={users} onUserResolved={onUserResolved} /> : <p className="min-w-0 self-center text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("subjects.allHelp")}</p>}</div>
          </div>
          <div className="min-w-0 space-y-2">
            <Label className="text-xs">{t("target")}</Label>
            <div className="grid min-w-0 gap-2 md:grid-cols-2"><Select value={targetType} onValueChange={value => setTargetType(value as MailQuotaTarget["type"])}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("targets.all")}</SelectItem><SelectItem value="domain">{t("targets.domain")}</SelectItem><SelectItem value="mailbox">{t("targets.mailbox")}</SelectItem></SelectContent></Select>{targetType === "domain" ? <Select value={targetDomain || domains[0] || ""} onValueChange={setTargetDomain}><SelectTrigger className={compactSelectTrigger}><SelectValue placeholder={t("targets.selectDomain")} /></SelectTrigger><SelectContent>{domains.map(domain => <SelectItem key={domain} value={domain}>{domain}</SelectItem>)}</SelectContent></Select> : targetType === "mailbox" ? <div className="grid min-w-0 gap-2 min-[520px]:grid-cols-2"><Input className="h-8 min-w-0" value={mailboxLocalPart} onChange={event => setMailboxLocalPart(event.target.value.split("@", 1)[0].slice(0, 64))} placeholder={t("targets.localPart")} /><Select value={mailboxDomain} onValueChange={setTargetDomain}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent>{domains.map(domain => <SelectItem key={domain} value={domain}>{domain}</SelectItem>)}</SelectContent></Select></div> : <p className="min-w-0 self-center text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("targets.allHelp")}</p>}</div>
          </div>
        </div>
        <div className={`grid min-w-0 gap-3 ${targetType === "mailbox" ? "lg:grid-cols-[minmax(0,1fr)_minmax(8rem,10rem)_auto]" : "lg:grid-cols-[minmax(0,1fr)_auto]"}`}><MailQuotaRuleFields id="new-mail-quota" rule={rolling} onChange={setRolling} />{targetType === "mailbox" && <div className="min-w-0 space-y-1"><Label htmlFor="new-mail-quota-lifetime" className="text-xs">{t("lifetime")}</Label><Input id="new-mail-quota-lifetime" className="h-8 min-w-0" type="number" min={-1} max={1_000_000_000} value={lifetimeLimit} onChange={event => setLifetimeLimit(Number(event.target.value))} /></div>}<Button type="button" size="sm" className="min-h-8 h-auto w-full self-end whitespace-normal lg:w-auto" disabled={!valid || duplicate} onClick={() => onChange([...rules, { id: crypto.randomUUID(), ...draft, rolling, lifetimeLimit: target.type === "mailbox" ? lifetimeLimit : -1, shareWithinRole: subject.type === "role" && shareWithinRole, ignoreEmperor: subject.type === "all" && ignoreEmperor }])}><Plus className="mr-1 h-4 w-4 shrink-0" />{t("add")}</Button></div>
        {subjectType === "all" && <QuotaToggle checked={ignoreEmperor} onChange={setIgnoreEmperor} label={t("ignoreEmperor")} help={t("ignoreEmperorHelp")} />}
        {subjectType === "role" && <QuotaToggle checked={shareWithinRole} onChange={setShareWithinRole} label={t("shareWithinRole")} help={t("shareWithinRoleHelp")} />}
        <p className={`min-w-0 text-xs leading-relaxed [overflow-wrap:anywhere] ${duplicate ? "text-destructive" : "text-muted-foreground"}`}>{duplicate ? t("duplicate") : t("ruleHelp")}</p>
      </div>
      {visibleRules.length === 0 ? <div className="rounded border border-dashed p-4 text-center text-sm leading-relaxed text-muted-foreground sm:p-8">{t("empty")}</div> : <div className="space-y-2">{visibleRules.map(rule => <div key={rule.id} className="min-w-0 space-y-3 rounded-md border p-3"><div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-start gap-2"><div className="min-w-0 space-y-1.5"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"><span className="min-w-0 font-medium [overflow-wrap:anywhere]">{subjectLabel(rule.subject)}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all font-mono text-xs">{targetLabel(rule.target)}</span></div><span className="inline-flex max-w-full rounded bg-muted px-1.5 py-0.5 text-[10px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{rule.subject.type === "all" ? t("pools.global") : rule.subject.type === "role" && rule.shareWithinRole ? t("pools.role") : t("pools.user")}</span></div><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" onClick={() => onChange(rules.filter(item => item.id !== rule.id))}><Trash2 className="h-4 w-4" /></Button></div><div className={`grid min-w-0 gap-2 ${rule.target.type === "mailbox" ? "lg:grid-cols-[minmax(0,1fr)_minmax(8rem,10rem)]" : ""}`}><MailQuotaRuleFields id={`mail-quota-${rule.id}`} rule={rule.rolling} onChange={rollingRule => updateRule(rule.id, { rolling: rollingRule })} />{rule.target.type === "mailbox" && <div className="min-w-0 space-y-1"><Label htmlFor={`mail-quota-${rule.id}-lifetime`} className="text-xs">{t("lifetime")}</Label><Input id={`mail-quota-${rule.id}-lifetime`} className="h-8 min-w-0" type="number" min={-1} max={1_000_000_000} value={rule.lifetimeLimit} onChange={event => updateRule(rule.id, { lifetimeLimit: Number(event.target.value) })} /></div>}</div>{rule.subject.type === "all" && <QuotaToggle checked={rule.ignoreEmperor} onChange={ignoreEmperorValue => updateRule(rule.id, { ignoreEmperor: ignoreEmperorValue })} label={t("ignoreEmperor")} />}{rule.subject.type === "role" && <QuotaToggle checked={rule.shareWithinRole} onChange={share => updateRule(rule.id, { shareWithinRole: share })} label={t("shareWithinRole")} />}</div>)}</div>}
    </section>
  )
}

export function MailQuotaUsageManager({ users, revision, onReset, onUserResolved }: {
  users: QuotaUser[]
  revision: number
  onReset: () => void
  onUserResolved?: (user: SearchableUser) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  const tRoles = useTranslations("profile.card.roles")
  const tFormat = useTranslations("common.format")
  const [direction, setDirection] = useState<MailDirection>("send")
  const [subjectType, setSubjectType] = useState<MailQuotaSubject["type"]>("all")
  const [role, setRole] = useState<Role>(ROLES.DUKE)
  const [userId, setUserId] = useState("")
  const [usage, setUsage] = useState<MailQuotaUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [failed, setFailed] = useState(false)
  const selected = subjectType === "all" || subjectType === "role" || Boolean(userId)

  useEffect(() => {
    if (!selected) { setUsage(null); return }
    const controller = new AbortController()
    const params = new URLSearchParams({ direction })
    if (subjectType === "all") params.set("scope", "global")
    else if (subjectType === "role") params.set("role", role)
    else params.set("userId", userId)
    setLoading(true)
    setFailed(false)
    void fetch(`/api/access-policies/usage?${params}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const body = await response.json() as { usage?: MailQuotaUsage }
        if (!response.ok || !body.usage) return Promise.reject()
        setUsage(body.usage)
      })
      .catch(error => {
        if (error instanceof Error && error.name === "AbortError") return
        setUsage(null)
        setFailed(true)
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [direction, revision, role, selected, subjectType, userId])

  const reset = async () => {
    if (!selected) return
    setResetting(true)
    setFailed(false)
    try {
      const target = subjectType === "all"
        ? { all: true }
        : subjectType === "role" ? { role } : { userId }
      const response = await fetch("/api/access-policies/usage", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction, ...target }),
      })
      if (!response.ok) {
        setFailed(true)
        return
      }
      onReset()
    } catch {
      setFailed(true)
    } finally {
      setResetting(false)
    }
  }

  const targetLabel = (assignment: MailQuotaAssignment) => assignment.target.type === "all"
    ? t("targets.all")
    : assignment.target.type === "domain"
      ? t("targets.domainValue", { domain: assignment.target.domain })
      : t("targets.mailboxValue", { address: assignment.target.address })
  const amount = (value: number | null) => value === null ? t("unlimited") : String(value)

  return (
    <section className="space-y-3 rounded-md border p-3">
      <div><h3 className="flex items-center gap-2 text-sm font-medium"><BarChart3 className="h-4 w-4 text-primary" />{t("usage.title")}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("usage.help")}</p></div>
      <div className="grid min-w-0 gap-2 md:grid-cols-3">
        <Select value={direction} onValueChange={value => setDirection(value as MailDirection)}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="send">{t("directions.send")}</SelectItem><SelectItem value="receive">{t("directions.receive")}</SelectItem></SelectContent></Select>
        <Select value={subjectType} onValueChange={value => setSubjectType(value as MailQuotaSubject["type"])}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("subjects.all")}</SelectItem><SelectItem value="role">{t("subjects.role")}</SelectItem><SelectItem value="user">{t("subjects.user")}</SelectItem></SelectContent></Select>
        {subjectType === "role" ? <Select value={role} onValueChange={value => setRole(value as Role)}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent>{roles.map(item => <SelectItem key={item} value={item}>{tRoles(roleTranslationKeys[item])}</SelectItem>)}</SelectContent></Select> : subjectType === "user" ? <SearchableUserSelect value={userId} onValueChange={setUserId} knownUsers={users} onUserResolved={onUserResolved} /> : <div className="flex min-h-8 min-w-0 items-center rounded border px-3 py-1.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("usage.siteWideHint")}</div>}
      </div>
      {failed && <p className="text-xs text-destructive">{t("usage.error")}</p>}
      {loading ? <div className="flex min-h-20 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div> : usage && <div className="space-y-2"><div className="text-xs text-muted-foreground">{tFormat("labelValue", { label: t("usage.allTime"), value: usage.allTimeCompleted })}</div>{usage.rules.length === 0 ? <div className="rounded border border-dashed p-4 text-center text-xs text-muted-foreground">{t("usage.empty")}</div> : usage.rules.map(item => <div key={item.assignment.id} className="grid min-w-0 gap-1.5 rounded border bg-muted/20 px-2 py-1.5 text-xs lg:grid-cols-[minmax(0,1fr)_minmax(0,auto)] lg:items-center"><span className="min-w-0 break-all font-mono">{t("usage.targetPool", { target: targetLabel(item.assignment), pool: t(item.assignment.subject.type === "all" ? "pools.global" : item.assignment.subject.type === "role" && item.assignment.shareWithinRole ? "pools.role" : "pools.user") })}</span><span className="min-w-0 leading-relaxed text-muted-foreground [overflow-wrap:anywhere] lg:text-right">{item.assignment.target.type === "mailbox" && item.assignment.lifetimeLimit >= 0 ? t("usage.ruleWithLifetime", { used: item.rolling.used, limit: amount(item.rolling.remaining === null ? null : item.rolling.rule.limit), pending: item.rolling.pending, lifetimeUsed: item.lifetimeUsed, lifetimeLimit: item.assignment.lifetimeLimit }) : t("usage.ruleLine", { used: item.rolling.used, limit: amount(item.rolling.remaining === null ? null : item.rolling.rule.limit), pending: item.rolling.pending })}</span></div>)}</div>}
      <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:justify-between"><p className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("reset.overlapWarning")}</p><AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="outline" size="sm" className="min-h-8 h-auto w-full shrink-0 whitespace-normal sm:w-auto" disabled={!selected || resetting}><RotateCcw className="mr-1 h-3.5 w-3.5 shrink-0" />{t("reset.action")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("reset.title")}</AlertDialogTitle><AlertDialogDescription>{t("reset.description")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => void reset()}>{t("reset.confirm")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>
    </section>
  )
}
