"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowRight, BarChart3, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, RotateCcw, Search, Trash2, X } from "lucide-react"
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
const RULES_PER_PAGE = 20

function subjectKey(subject: MailQuotaSubject) {
  return subject.type === "all" ? "all" : subject.type === "role" ? `role:${subject.role}` : `user:${subject.userId}`
}

function targetKey(target: MailQuotaTarget) {
  return target.type === "all" ? "all" : target.type === "domain" ? `domain:${target.domain}` : `mailbox:${target.address}`
}

function assignmentKey(assignment: Pick<MailQuotaAssignment, "direction" | "subject" | "target">) {
  return `${assignment.direction}|${subjectKey(assignment.subject)}|${targetKey(assignment.target)}`
}

function validQuotaRule(rule: MailQuotaRule) {
  return Number.isSafeInteger(rule.limit)
    && rule.limit >= -1
    && rule.limit <= 1_000_000_000
    && Number.isSafeInteger(rule.windowValue)
    && rule.windowValue >= 1
    && rule.windowValue <= 100_000
}

function cloneAssignment(rule: MailQuotaAssignment): MailQuotaAssignment {
  return { ...rule, subject: { ...rule.subject }, target: { ...rule.target }, rolling: { ...rule.rolling } }
}

function numericInput(raw: string) {
  return raw.trim() === "" ? Number.NaN : Number(raw)
}

function quotaMode(limit: number) {
  return limit < 0 ? "unlimited" : limit === 0 ? "blocked" : "custom"
}

export function MailQuotaRuleFields({ id, rule, onChange }: {
  id: string
  rule: MailQuotaRule
  onChange: (value: MailQuotaRule) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  const mode = quotaMode(rule.limit)
  return (
    <div className={`grid min-w-0 gap-2 ${mode === "custom" ? "min-[680px]:grid-cols-[minmax(8rem,.9fr)_minmax(5rem,.7fr)_minmax(5rem,.6fr)_minmax(7.5rem,1fr)]" : "min-[420px]:grid-cols-[minmax(8rem,12rem)]"}`}>
      <div className="min-w-0 space-y-1"><Label className="text-xs">{t("manager.limitMode")}</Label><Select value={mode} onValueChange={value => onChange({ ...rule, limit: value === "unlimited" ? -1 : value === "blocked" ? 0 : rule.limit > 0 ? rule.limit : 100 })}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unlimited">{t("manager.modes.unlimited")}</SelectItem><SelectItem value="blocked">{t("manager.modes.blocked")}</SelectItem><SelectItem value="custom">{t("manager.modes.custom")}</SelectItem></SelectContent></Select></div>
      {mode === "custom" && <><div className="min-w-0 space-y-1"><Label htmlFor={`${id}-limit`} className="text-xs">{t("limit")}</Label><Input id={`${id}-limit`} className="h-8 min-w-0" type="number" min={1} max={1_000_000_000} value={Number.isFinite(rule.limit) ? rule.limit : ""} onChange={event => onChange({ ...rule, limit: numericInput(event.target.value) })} /></div>
      <div className="min-w-0 space-y-1"><Label htmlFor={`${id}-window`} className="text-xs">{t("every")}</Label><Input id={`${id}-window`} className="h-8 min-w-0" type="number" min={1} max={100_000} value={Number.isFinite(rule.windowValue) ? rule.windowValue : ""} onChange={event => onChange({ ...rule, windowValue: numericInput(event.target.value) })} /></div>
      <div className="min-w-0 space-y-1"><Label className="text-xs">{t("unit")}</Label><Select value={rule.windowUnit} onValueChange={windowUnit => onChange({ ...rule, windowUnit: windowUnit as MailQuotaUnit })}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent>{units.map(unit => <SelectItem key={unit} value={unit}>{t(`units.${unit}` as never)}</SelectItem>)}</SelectContent></Select></div></>}
    </div>
  )
}

function LifetimeQuotaField({ id, value, onChange }: { id: string; value: number; onChange: (value: number) => void }) {
  const t = useTranslations("admin.access.mailQuota")
  const mode = quotaMode(value)
  return (
    <div className={`grid min-w-0 gap-2 ${mode === "custom" ? "min-[420px]:grid-cols-[minmax(8rem,1fr)_minmax(7rem,1fr)]" : ""}`}>
      <div className="min-w-0 space-y-1"><Label className="text-xs">{t("manager.lifetimeMode")}</Label><Select value={mode} onValueChange={next => onChange(next === "unlimited" ? -1 : next === "blocked" ? 0 : value > 0 ? value : 100)}><SelectTrigger className={compactSelectTrigger}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unlimited">{t("manager.modes.unlimited")}</SelectItem><SelectItem value="blocked">{t("manager.modes.blocked")}</SelectItem><SelectItem value="custom">{t("manager.modes.custom")}</SelectItem></SelectContent></Select></div>
      {mode === "custom" && <div className="min-w-0 space-y-1"><Label htmlFor={id} className="text-xs">{t("lifetime")}</Label><Input id={id} className="h-8 min-w-0" type="number" min={1} max={1_000_000_000} value={Number.isFinite(value) ? value : ""} onChange={event => onChange(numericInput(event.target.value))} /></div>}
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
  const [creating, setCreating] = useState(false)
  const [editingRule, setEditingRule] = useState<MailQuotaAssignment | null>(null)
  const [query, setQuery] = useState("")
  const [subjectFilter, setSubjectFilter] = useState<"any" | MailQuotaSubject["type"]>("any")
  const [targetFilter, setTargetFilter] = useState<"any" | MailQuotaTarget["type"]>("any")
  const [page, setPage] = useState(1)
  const editorRef = useRef<HTMLDivElement>(null)
  const userNames = useMemo(() => new Map(users.map(user => [user.id, identity(user)])), [users])
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
  const maximumReached = rules.length >= 2_000
  const valid = (subjectType !== "user" || Boolean(subjectUserId))
    && (targetType === "all" || Boolean(mailboxDomain))
    && (targetType !== "mailbox" || Boolean(mailboxName))
    && validQuotaRule(rolling)
    && (targetType !== "mailbox" || (Number.isSafeInteger(lifetimeLimit) && lifetimeLimit >= -1 && lifetimeLimit <= 1_000_000_000))

  const subjectLabel = (value: MailQuotaSubject) => value.type === "all"
    ? t("subjects.all")
    : value.type === "role"
      ? t("subjects.roleValue", { role: tRoles(roleTranslationKeys[value.role]) })
      : t("subjects.userValue", { user: userNames.get(value.userId) ?? value.userId })
  const targetLabel = (value: MailQuotaTarget) => value.type === "all"
    ? t("targets.all")
    : value.type === "domain" ? t("targets.domainValue", { domain: value.domain }) : t("targets.mailboxValue", { address: value.address })
  const directionRules = useMemo(() => rules.filter(rule => rule.direction === direction), [direction, rules])
  const filteredRules = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return directionRules.filter(rule => {
      if (subjectFilter !== "any" && rule.subject.type !== subjectFilter) return false
      if (targetFilter !== "any" && rule.target.type !== targetFilter) return false
      if (!needle) return true
      const localizedSubject = rule.subject.type === "all"
        ? t("subjects.all")
        : rule.subject.type === "role"
          ? t("subjects.roleValue", { role: tRoles(roleTranslationKeys[rule.subject.role]) })
          : t("subjects.userValue", { user: userNames.get(rule.subject.userId) ?? rule.subject.userId })
      const localizedTarget = rule.target.type === "all"
        ? t("targets.all")
        : rule.target.type === "domain"
          ? t("targets.domainValue", { domain: rule.target.domain })
          : t("targets.mailboxValue", { address: rule.target.address })
      return `${localizedSubject} ${localizedTarget} ${subjectKey(rule.subject)} ${targetKey(rule.target)}`.toLocaleLowerCase().includes(needle)
    })
  }, [directionRules, query, subjectFilter, t, tRoles, targetFilter, userNames])
  const totalPages = Math.max(1, Math.ceil(filteredRules.length / RULES_PER_PAGE))
  const pageRules = filteredRules.slice((page - 1) * RULES_PER_PAGE, page * RULES_PER_PAGE)
  const editingValid = editingRule !== null
    && validQuotaRule(editingRule.rolling)
    && (editingRule.target.type !== "mailbox" || (
      Number.isSafeInteger(editingRule.lifetimeLimit)
      && editingRule.lifetimeLimit >= -1
      && editingRule.lifetimeLimit <= 1_000_000_000
    ))

  useEffect(() => {
    setPage(current => Math.min(current, totalPages))
  }, [totalPages])

  useEffect(() => {
    if (editingRule && !rules.some(rule => rule.id === editingRule.id)) setEditingRule(null)
  }, [editingRule, rules])

  const closeEditor = () => {
    setCreating(false)
    setEditingRule(null)
  }
  const openCreate = () => {
    setEditingRule(null)
    setCreating(true)
  }
  const openEdit = (rule: MailQuotaAssignment) => {
    setCreating(false)
    setEditingRule(cloneAssignment(rule))
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" }))
  }
  const addRule = () => {
    if (!valid || duplicate || maximumReached) return
    const newRule: MailQuotaAssignment = {
      id: crypto.randomUUID(),
      ...draft,
      rolling: { ...rolling },
      lifetimeLimit: target.type === "mailbox" ? lifetimeLimit : -1,
      shareWithinRole: subject.type === "role" && shareWithinRole,
      ignoreEmperor: subject.type === "all" && ignoreEmperor,
    }
    onChange([...rules, newRule])
    setQuery("")
    setSubjectFilter("any")
    setTargetFilter("any")
    setPage(Math.ceil((directionRules.length + 1) / RULES_PER_PAGE))
    closeEditor()
  }
  const applyEdit = () => {
    if (!editingRule || !editingValid) return
    onChange(rules.map(rule => rule.id === editingRule.id ? cloneAssignment(editingRule) : rule))
    closeEditor()
  }
  const deleteRule = (id: string) => {
    onChange(rules.filter(rule => rule.id !== id))
    if (editingRule?.id === id) closeEditor()
  }
  const changeDirection = (value: string) => {
    setDirection(value as MailDirection)
    setPage(1)
    closeEditor()
  }
  const rollingSummary = (rule: MailQuotaRule) => rule.limit < 0
    ? t("manager.rollingUnlimited")
    : rule.limit === 0
      ? t("manager.rollingBlocked")
      : t("manager.rollingSummary", { limit: rule.limit, windowValue: rule.windowValue, unit: t(`units.${rule.windowUnit}` as never) })
  const lifetimeSummary = (limit: number) => limit < 0
    ? t("manager.lifetimeUnlimited")
    : limit === 0 ? t("manager.lifetimeBlocked") : t("manager.lifetimeSummary", { limit })

  return (
    <section className="space-y-4">
      <div><h3 className="text-sm font-medium">{t("title")}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("help")}</p></div>
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground"><p>{t("precedence")}</p><p className="mt-1">{t("independent")}</p></div>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={direction} onValueChange={changeDirection}><TabsList className="flex h-auto w-full min-[420px]:w-auto"><TabsTrigger className="min-w-0 flex-1 min-[420px]:flex-none" value="send">{t("directions.send")}</TabsTrigger><TabsTrigger className="min-w-0 flex-1 min-[420px]:flex-none" value="receive">{t("directions.receive")}</TabsTrigger></TabsList></Tabs>
        <Button type="button" size="sm" className="w-full sm:w-auto" onClick={creating ? closeEditor : openCreate}>{creating ? <X className="mr-1 h-4 w-4" /> : <Plus className="mr-1 h-4 w-4" />}{creating ? t("manager.close") : t("manager.new")}</Button>
      </div>

      {(creating || editingRule) && <div ref={editorRef} className="min-w-0 scroll-mt-4 space-y-3 rounded-md border border-primary/30 bg-primary/[0.03] p-3 sm:p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0"><h4 className="text-sm font-medium">{creating ? t("manager.createTitle") : t("manager.editTitle")}</h4><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("manager.editorHelp")}</p></div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={closeEditor} aria-label={t("manager.close")} title={t("manager.close")}><X className="h-4 w-4" /></Button>
        </div>

        {creating ? <>
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
          <div className={`grid min-w-0 gap-3 ${targetType === "mailbox" ? "lg:grid-cols-[minmax(0,1fr)_minmax(12rem,.65fr)]" : ""}`}><MailQuotaRuleFields id="new-mail-quota" rule={rolling} onChange={setRolling} />{targetType === "mailbox" && <LifetimeQuotaField id="new-mail-quota-lifetime" value={lifetimeLimit} onChange={setLifetimeLimit} />}</div>
          {subjectType === "all" && <QuotaToggle checked={ignoreEmperor} onChange={setIgnoreEmperor} label={t("ignoreEmperor")} help={t("ignoreEmperorHelp")} />}
          {subjectType === "role" && <QuotaToggle checked={shareWithinRole} onChange={setShareWithinRole} label={t("shareWithinRole")} help={t("shareWithinRoleHelp")} />}
          <p className={`min-w-0 text-xs leading-relaxed [overflow-wrap:anywhere] ${duplicate || maximumReached ? "text-destructive" : "text-muted-foreground"}`}>{maximumReached ? t("manager.maximum") : duplicate ? t("duplicate") : t("ruleHelp")}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" size="sm" onClick={closeEditor}>{t("manager.cancel")}</Button><Button type="button" size="sm" disabled={!valid || duplicate || maximumReached} onClick={addRule}><Plus className="mr-1 h-4 w-4" />{t("add")}</Button></div>
        </> : editingRule && <>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/50 p-2.5 text-sm"><span className="min-w-0 font-medium [overflow-wrap:anywhere]">{subjectLabel(editingRule.subject)}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all font-mono text-xs">{targetLabel(editingRule.target)}</span></div>
          <div className={`grid min-w-0 gap-3 ${editingRule.target.type === "mailbox" ? "lg:grid-cols-[minmax(0,1fr)_minmax(12rem,.65fr)]" : ""}`}><MailQuotaRuleFields id={`edit-mail-quota-${editingRule.id}`} rule={editingRule.rolling} onChange={rollingRule => setEditingRule(current => current ? { ...current, rolling: rollingRule } : null)} />{editingRule.target.type === "mailbox" && <LifetimeQuotaField id={`edit-mail-quota-${editingRule.id}-lifetime`} value={editingRule.lifetimeLimit} onChange={value => setEditingRule(current => current ? { ...current, lifetimeLimit: value } : null)} />}</div>
          {editingRule.subject.type === "all" && <QuotaToggle checked={editingRule.ignoreEmperor} onChange={value => setEditingRule(current => current ? { ...current, ignoreEmperor: value } : null)} label={t("ignoreEmperor")} help={t("ignoreEmperorHelp")} />}
          {editingRule.subject.type === "role" && <QuotaToggle checked={editingRule.shareWithinRole} onChange={value => setEditingRule(current => current ? { ...current, shareWithinRole: value } : null)} label={t("shareWithinRole")} help={t("shareWithinRoleHelp")} />}
          <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("manager.identityLocked")}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" size="sm" onClick={closeEditor}>{t("manager.cancel")}</Button><Button type="button" size="sm" disabled={!editingValid} onClick={applyEdit}>{t("manager.apply")}</Button></div>
        </>}
      </div>}

      <div className="min-w-0 space-y-3 rounded-md border bg-muted/[0.15] p-3">
        <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(12rem,1fr)_minmax(9rem,.45fr)_minmax(9rem,.45fr)]">
          <div className="relative min-w-0"><Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" /><Input className="h-8 min-w-0 pl-8" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} placeholder={t("manager.search")} aria-label={t("manager.search")} /></div>
          <Select value={subjectFilter} onValueChange={value => { setSubjectFilter(value as typeof subjectFilter); setPage(1) }}><SelectTrigger className={compactSelectTrigger} aria-label={t("manager.subjectFilter")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any">{t("manager.allSubjects")}</SelectItem><SelectItem value="all">{t("subjects.all")}</SelectItem><SelectItem value="role">{t("subjects.role")}</SelectItem><SelectItem value="user">{t("subjects.user")}</SelectItem></SelectContent></Select>
          <Select value={targetFilter} onValueChange={value => { setTargetFilter(value as typeof targetFilter); setPage(1) }}><SelectTrigger className={compactSelectTrigger} aria-label={t("manager.targetFilter")}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="any">{t("manager.allTargets")}</SelectItem><SelectItem value="all">{t("targets.all")}</SelectItem><SelectItem value="domain">{t("targets.domain")}</SelectItem><SelectItem value="mailbox">{t("targets.mailbox")}</SelectItem></SelectContent></Select>
        </div>
        <p className="text-xs text-muted-foreground">{t("manager.count", { visible: filteredRules.length, total: directionRules.length })}</p>
      </div>

      {directionRules.length === 0 ? <div className="rounded border border-dashed p-4 text-center text-sm leading-relaxed text-muted-foreground sm:p-8">{t("empty")}</div> : filteredRules.length === 0 ? <div className="rounded border border-dashed p-4 text-center text-sm leading-relaxed text-muted-foreground sm:p-8">{t("manager.noResults")}</div> : <>
        <div className="space-y-2">{pageRules.map(rule => <article key={rule.id} className={`min-w-0 rounded-md border p-3 transition-colors ${editingRule?.id === rule.id ? "border-primary/50 bg-primary/[0.03]" : "bg-background"}`}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0 space-y-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm"><span className="min-w-0 font-medium [overflow-wrap:anywhere]">{subjectLabel(rule.subject)}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all font-mono text-xs">{targetLabel(rule.target)}</span></div>
              <div className="flex min-w-0 flex-wrap gap-1.5 text-[11px] leading-relaxed text-muted-foreground"><span className="rounded bg-muted px-1.5 py-0.5">{rule.subject.type === "all" ? t("pools.global") : rule.subject.type === "role" && rule.shareWithinRole ? t("pools.role") : t("pools.user")}</span><span className="rounded bg-muted px-1.5 py-0.5">{rollingSummary(rule.rolling)}</span>{rule.target.type === "mailbox" && <span className="rounded bg-muted px-1.5 py-0.5">{lifetimeSummary(rule.lifetimeLimit)}</span>}{rule.subject.type === "all" && rule.ignoreEmperor && <span className="rounded bg-muted px-1.5 py-0.5">{t("ignoreEmperor")}</span>}</div>
            </div>
            <div className="flex shrink-0 justify-end gap-1.5">
              <Button type="button" variant={editingRule?.id === rule.id ? "secondary" : "outline"} size="sm" className="h-8" onClick={() => openEdit(rule)} aria-label={t("manager.edit")} title={t("manager.edit")}><Pencil className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">{t("manager.edit")}</span></Button>
              <AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label={t("manager.delete")} title={t("manager.delete")}><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("manager.deleteTitle")}</AlertDialogTitle><AlertDialogDescription>{t("manager.deleteDescription")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("manager.cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteRule(rule.id)}>{t("manager.delete")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
            </div>
          </div>
        </article>)}</div>
        <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground min-[480px]:flex-row min-[480px]:items-center min-[480px]:justify-between">
          <span>{t("manager.page", { current: page, total: totalPages })}</span>
          {totalPages > 1 && <div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeft className="mr-1 h-4 w-4" />{t("manager.previous")}</Button><Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(value => Math.min(totalPages, value + 1))}>{t("manager.next")}<ChevronRight className="ml-1 h-4 w-4" /></Button></div>}
        </div>
      </>}
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
