"use client"

import { useState } from "react"
import { BarChart3, Globe2, Mail, RotateCcw } from "lucide-react"
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
import { normalizeMailboxCreationName } from "@/lib/email-address"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type MailDirection = "send" | "receive"
export type MailQuotaUnit = "second" | "minute" | "hour" | "day" | "week" | "month"
export type MailQuotaRule = { limit: number; windowValue: number; windowUnit: MailQuotaUnit }
export type MailboxQuotaRule = { rolling: MailQuotaRule; lifetimeLimit: number }
export type MailQuotaPolicy = {
  scope: "user" | "role"
  total: MailQuotaRule
  domains: Record<string, MailQuotaRule>
  mailbox: MailboxQuotaRule
  domainMailboxes: Record<string, MailboxQuotaRule>
  mailboxes: Record<string, MailboxQuotaRule>
}
export type MailQuotaOverride = {
  total?: MailQuotaRule
  domains?: Record<string, MailQuotaRule>
  mailbox?: MailboxQuotaRule
  domainMailboxes?: Record<string, MailboxQuotaRule>
  mailboxes?: Record<string, MailboxQuotaRule>
}
export type MailQuotaCounter = {
  rule: MailQuotaRule
  completed: number
  pending: number
  used: number
  remaining: number | null
}
export type MailQuotaUsage = {
  direction: MailDirection
  scope: "user" | "role"
  aggregate: boolean
  allTimeCompleted: number
  total: MailQuotaCounter
  domains: Array<MailQuotaCounter & { domain: string; allTimeCompleted: number }>
}

const units: MailQuotaUnit[] = ["second", "minute", "hour", "day", "week", "month"]
const unlimitedRule = (): MailQuotaRule => ({ limit: -1, windowValue: 1, windowUnit: "day" })
const unlimitedMailboxRule = (): MailboxQuotaRule => ({ rolling: unlimitedRule(), lifetimeLimit: -1 })

function RuleEditor({ id, rule, onChange }: {
  id: string
  rule: MailQuotaRule
  onChange: (value: MailQuotaRule) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  return (
    <div className="grid gap-2 min-[420px]:grid-cols-[minmax(4.5rem,.7fr)_minmax(4.5rem,.55fr)_minmax(6.5rem,1fr)]">
      <div className="space-y-1">
        <Label htmlFor={`${id}-limit`} className="text-xs">{t("limit")}</Label>
        <Input id={`${id}-limit`} className="h-8" type="number" min={-1} max={1_000_000_000} value={rule.limit} onChange={event => onChange({ ...rule, limit: Number(event.target.value) })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-window`} className="text-xs">{t("every")}</Label>
        <Input id={`${id}-window`} className="h-8" type="number" min={1} max={100_000} value={rule.windowValue} onChange={event => onChange({ ...rule, windowValue: Number(event.target.value) })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("unit")}</Label>
        <Select value={rule.windowUnit} onValueChange={value => onChange({ ...rule, windowUnit: value as MailQuotaUnit })}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>{units.map(unit => <SelectItem key={unit} value={unit}>{t(`units.${unit}` as never)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  )
}

function MailboxRuleEditor({ id, rule, onChange }: {
  id: string
  rule: MailboxQuotaRule
  onChange: (value: MailboxQuotaRule) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_8rem]">
      <RuleEditor id={`${id}-rolling`} rule={rule.rolling} onChange={rolling => onChange({ ...rule, rolling })} />
      <div className="space-y-1">
        <Label htmlFor={`${id}-lifetime`} className="text-xs">{t("lifetime")}</Label>
        <Input id={`${id}-lifetime`} className="h-8" type="number" min={-1} max={1_000_000_000} value={rule.lifetimeLimit} onChange={event => onChange({ ...rule, lifetimeLimit: Number(event.target.value) })} />
      </div>
    </div>
  )
}

function UsagePanel({ usage, onReset }: { usage: MailQuotaUsage | null; onReset?: () => void }) {
  const t = useTranslations("admin.access.mailQuota")
  if (!usage) return null
  const limit = (value: MailQuotaCounter) => value.rule.limit < 0 ? t("unlimited") : String(value.rule.limit)
  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium"><BarChart3 className="h-3.5 w-3.5 text-primary" />{t("usage.title")}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{usage.aggregate ? t("usage.aggregate") : usage.scope === "role" ? t("usage.shared") : t("usage.individual")}</span>
          {onReset && (
            <AlertDialog>
              <AlertDialogTrigger asChild><Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs"><RotateCcw className="mr-1 h-3 w-3" />{t("reset.action")}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>{t("reset.title")}</AlertDialogTitle><AlertDialogDescription>{t("reset.description")}</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel><AlertDialogAction onClick={onReset}>{t("reset.confirm")}</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div><span className="text-muted-foreground">{t("usage.allTime")}</span><strong className="ml-2">{usage.allTimeCompleted}</strong></div>
        <div><span className="text-muted-foreground">{t("usage.window")}</span><strong className="ml-2">{usage.total.completed} / {limit(usage.total)}</strong></div>
        <div><span className="text-muted-foreground">{t("usage.pending")}</span><strong className="ml-2">{usage.total.pending}</strong></div>
      </div>
      {usage.domains.length > 0 && <div className="mt-3 grid gap-1.5 sm:grid-cols-2">{usage.domains.map(domain => <div key={domain.domain} className="flex items-center justify-between gap-3 rounded border bg-background/70 px-2 py-1.5 text-xs"><span className="min-w-0 truncate font-mono">{domain.domain}</span><span className="shrink-0 text-muted-foreground">{t("usage.domainLine", { allTime: domain.allTimeCompleted, completed: domain.completed, limit: limit(domain) })}</span></div>)}</div>}
    </div>
  )
}

function ExactMailboxRules({ id, domains, rules, fallback, onChange, onReset }: {
  id: string
  domains: string[]
  rules: Record<string, MailboxQuotaRule>
  fallback: (address: string) => MailboxQuotaRule
  onChange: (rules: Record<string, MailboxQuotaRule>) => void
  onReset?: (address: string) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  const [localPart, setLocalPart] = useState("")
  const [domain, setDomain] = useState(domains[0] ?? "")
  const normalizedLocalPart = normalizeMailboxCreationName(localPart)
  const invalidLocalPart = localPart.length > 0 && !normalizedLocalPart
  const add = () => {
    if (!normalizedLocalPart || !domain) return
    const address = `${normalizedLocalPart}@${domain}`
    onChange({ ...rules, [address]: structuredClone(fallback(address)) })
    setLocalPart("")
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium"><Mail className="h-3.5 w-3.5 text-primary" />{t("exact.title")}</div>
      <p className="text-xs text-muted-foreground">{t("exact.help")}</p>
      <div className="grid gap-2 sm:grid-cols-[minmax(7rem,1fr)_minmax(8rem,1fr)_auto]">
        <Input
          className="h-8"
          value={localPart}
          onChange={event => setLocalPart(event.target.value.split("@", 1)[0].slice(0, 64))}
          placeholder={t("exact.localPart")}
          maxLength={64}
          pattern="[A-Za-z0-9._+-]+"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
        />
        <Select value={domain} onValueChange={setDomain}><SelectTrigger className="h-8"><SelectValue placeholder={t("exact.domain")} /></SelectTrigger><SelectContent>{domains.map(item => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
        <Button type="button" size="sm" variant="outline" className="h-8" disabled={!normalizedLocalPart || !domain} onClick={add}>{t("exact.add")}</Button>
      </div>
      {invalidLocalPart && <p className="text-xs text-destructive">{t("exact.invalidLocalPart")}</p>}
      {Object.entries(rules).map(([address, rule]) => <div key={address} className="space-y-2 rounded-md border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 truncate font-mono text-xs">{address}</span><div className="flex items-center gap-1">{onReset && <AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs"><RotateCcw className="mr-1 h-3 w-3" />{t("exact.reset")}</Button></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("reset.mailboxTitle")}</AlertDialogTitle><AlertDialogDescription>{t("reset.mailboxDescription", { address })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("reset.cancel")}</AlertDialogCancel><AlertDialogAction onClick={() => onReset(address)}>{t("reset.confirm")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}<Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={() => { const next = { ...rules }; delete next[address]; onChange(next) }}>{t("exact.remove")}</Button></div></div><MailboxRuleEditor id={`${id}-${address}`} rule={rule} onChange={next => onChange({ ...rules, [address]: next })} /></div>)}
    </div>
  )
}

function RoleQuotaFields({ id, domains, quota, onChange, onResetMailbox }: {
  id: string; domains: string[]; quota: MailQuotaPolicy; onChange: (value: MailQuotaPolicy) => void; onResetMailbox?: (address: string) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  return <>
    <div className="rounded-md border p-3"><div className="mb-2 text-xs font-medium">{t("total")}</div><RuleEditor id={`${id}-total`} rule={quota.total} onChange={total => onChange({ ...quota, total })} /></div>
    <div className="rounded-md border p-3"><div className="mb-2 text-xs font-medium">{t("mailboxDefault")}</div><MailboxRuleEditor id={`${id}-mailbox`} rule={quota.mailbox} onChange={mailbox => onChange({ ...quota, mailbox })} /></div>
    <div className="space-y-2"><div className="flex items-center gap-2 text-xs font-medium"><Globe2 className="h-3.5 w-3.5 text-primary" />{t("domains")}</div>{domains.map(domain => { const aggregate = quota.domains[domain]; const mailbox = quota.domainMailboxes[domain]; return <div key={domain} className="space-y-2 rounded-md border p-3"><span className="block truncate font-mono text-xs">{domain}</span><label className="flex items-center gap-2 text-xs"><Checkbox checked={Boolean(aggregate)} onChange={enabled => { const next = { ...quota.domains }; if (enabled) next[domain] = unlimitedRule(); else delete next[domain]; onChange({ ...quota, domains: next }) }} />{t("domainTotal")}</label>{aggregate && <RuleEditor id={`${id}-${domain}-total`} rule={aggregate} onChange={value => onChange({ ...quota, domains: { ...quota.domains, [domain]: value } })} />}<label className="flex items-center gap-2 text-xs"><Checkbox checked={Boolean(mailbox)} onChange={enabled => { const next = { ...quota.domainMailboxes }; if (enabled) next[domain] = unlimitedMailboxRule(); else delete next[domain]; onChange({ ...quota, domainMailboxes: next }) }} />{t("domainMailbox")}</label>{mailbox && <MailboxRuleEditor id={`${id}-${domain}-mailbox`} rule={mailbox} onChange={value => onChange({ ...quota, domainMailboxes: { ...quota.domainMailboxes, [domain]: value } })} />}</div> })}</div>
    <ExactMailboxRules id={`${id}-exact`} domains={domains} rules={quota.mailboxes} fallback={address => quota.domainMailboxes[address.slice(address.lastIndexOf("@") + 1)] ?? quota.mailbox} onChange={mailboxes => onChange({ ...quota, mailboxes })} onReset={onResetMailbox} />
  </>
}

export function RoleMailQuotaEditor({ direction, role, domains, quota, usage, onChange, onReset, onResetMailbox }: {
  direction: MailDirection; role: string; domains: string[]; quota: MailQuotaPolicy; usage: MailQuotaUsage | null; onChange: (value: MailQuotaPolicy) => void; onReset: () => void; onResetMailbox: (address: string) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  return <section className="space-y-3 rounded border p-4 xl:col-span-2"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-medium">{t(`${direction}.title` as never)}</h3><p className="mt-1 text-xs text-muted-foreground">{t(`${direction}.help` as never)}</p></div><Select value={quota.scope} onValueChange={scope => onChange({ ...quota, scope: scope as "user" | "role" })}><SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">{t("scope.user")}</SelectItem><SelectItem value="role">{t("scope.role")}</SelectItem></SelectContent></Select></div><RoleQuotaFields id={`role-${role}-${direction}`} domains={domains} quota={quota} onChange={onChange} onResetMailbox={onResetMailbox} /><UsagePanel usage={usage} onReset={onReset} /></section>
}

export function UserMailQuotaEditor({ direction, userId, domains, inherited, override, usage, onChange, onReset, onResetMailbox }: {
  direction: MailDirection; userId: string; domains: string[]; inherited: MailQuotaPolicy; override: MailQuotaOverride | undefined; usage: MailQuotaUsage | null; onChange: (value: MailQuotaOverride | undefined) => void; onReset: () => void; onResetMailbox: (address: string) => void
}) {
  const t = useTranslations("admin.access.mailQuota")
  const update = (next: MailQuotaOverride) => onChange(Object.values(next).every(value => value === undefined) ? undefined : next)
  const exact = override?.mailboxes ?? {}
  return <section className="space-y-3 rounded border p-4 xl:col-span-2"><div><h3 className="text-sm font-medium">{t(`${direction}.userTitle` as never)}</h3><p className="mt-1 text-xs text-muted-foreground">{t("userHelp")}</p></div><div className="space-y-2 rounded-md border p-3"><label className="flex items-center gap-2 text-xs font-medium"><Checkbox checked={Boolean(override?.total)} onChange={enabled => update({ ...override, total: enabled ? structuredClone(inherited.total) : undefined })} />{t("overrideTotal")}</label>{override?.total && <RuleEditor id={`user-${userId}-${direction}-total`} rule={override.total} onChange={total => update({ ...override, total })} />}</div><div className="space-y-2 rounded-md border p-3"><label className="flex items-center gap-2 text-xs font-medium"><Checkbox checked={Boolean(override?.mailbox)} onChange={enabled => update({ ...override, mailbox: enabled ? structuredClone(inherited.mailbox) : undefined })} />{t("overrideMailbox")}</label>{override?.mailbox && <MailboxRuleEditor id={`user-${userId}-${direction}-mailbox`} rule={override.mailbox} onChange={mailbox => update({ ...override, mailbox })} />}</div><div className="grid gap-2">{domains.map(domain => { const aggregate = override?.domains?.[domain]; const mailbox = override?.domainMailboxes?.[domain]; return <div key={domain} className="space-y-2 rounded-md border p-3"><span className="block truncate font-mono text-xs">{domain}</span><label className="flex items-center gap-2 text-xs"><Checkbox checked={Boolean(aggregate)} onChange={enabled => { const domainsMap = { ...override?.domains }; if (enabled) domainsMap[domain] = structuredClone(inherited.domains[domain] ?? unlimitedRule()); else delete domainsMap[domain]; update({ ...override, domains: Object.keys(domainsMap).length ? domainsMap : undefined }) }} />{t("overrideDomain")}</label>{aggregate && <RuleEditor id={`user-${userId}-${direction}-${domain}-total`} rule={aggregate} onChange={value => update({ ...override, domains: { ...override?.domains, [domain]: value } })} />}<label className="flex items-center gap-2 text-xs"><Checkbox checked={Boolean(mailbox)} onChange={enabled => { const map = { ...override?.domainMailboxes }; if (enabled) map[domain] = structuredClone(inherited.domainMailboxes[domain] ?? inherited.mailbox); else delete map[domain]; update({ ...override, domainMailboxes: Object.keys(map).length ? map : undefined }) }} />{t("overrideDomainMailbox")}</label>{mailbox && <MailboxRuleEditor id={`user-${userId}-${direction}-${domain}-mailbox`} rule={mailbox} onChange={value => update({ ...override, domainMailboxes: { ...override?.domainMailboxes, [domain]: value } })} />}</div> })}</div><ExactMailboxRules id={`user-${userId}-${direction}-exact`} domains={domains} rules={exact} fallback={address => inherited.mailboxes[address] ?? inherited.domainMailboxes[address.slice(address.lastIndexOf("@") + 1)] ?? inherited.mailbox} onChange={mailboxes => update({ ...override, mailboxes: Object.keys(mailboxes).length ? mailboxes : undefined })} onReset={onResetMailbox} /><UsagePanel usage={usage} onReset={onReset} /></section>
}
