"use client"

import { useEffect, useState } from "react"
import { BarChart3, Clock3, HardDrive, KeyRound, Mail } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import type { MailQuotaAssignment, MailQuotaUsage } from "./mail-quota-editor"

type SelfQuotaResponse = {
  access?: {
    quotas: { maxActiveMailboxes: number; maxMailboxLifetimeDays: number; maxMessageBytes: number }
    mailQuotaRules: MailQuotaAssignment[]
  }
  usage?: { activeMailboxes: number; activeApiKeys: number; send: MailQuotaUsage; receive: MailQuotaUsage }
}

function MailUsage({ direction, usage }: { direction: "send" | "receive"; usage: MailQuotaUsage }) {
  const format = useFormatter()
  const t = useTranslations("profile.myQuotas")
  const amount = (value: number | null) => value === null || value < 0 ? t("unlimited") : format.number(value)
  const target = (rule: MailQuotaAssignment) => rule.target.type === "all"
    ? t("targets.all")
    : rule.target.type === "domain" ? t("targets.domain", { domain: rule.target.domain }) : t("targets.mailbox", { address: rule.target.address })
  return (
    <div className="min-w-0 space-y-2 rounded-md border p-3">
      <div className="flex min-w-0 flex-col items-start gap-1.5 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between"><span className="flex min-w-0 items-center gap-1.5 text-sm font-medium [overflow-wrap:anywhere]"><Mail className="h-4 w-4 shrink-0 text-primary" />{t(direction)}</span><span className="max-w-full rounded bg-primary/10 px-2 py-0.5 text-xs leading-relaxed text-primary [overflow-wrap:anywhere]">{t("independent")}</span></div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("precedenceHelp")}</p>
      {usage.rules.length === 0 ? <p className="rounded border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">{t("noRules")}</p> : <div className="space-y-1.5">{usage.rules.map(item => <div key={item.assignment.id} className="grid min-w-0 gap-1 rounded border bg-muted/20 px-2 py-1.5 text-xs"><span className="min-w-0 break-all font-mono">{target(item.assignment)} · {t(item.assignment.subject.type === "all" ? "pools.global" : item.assignment.subject.type === "role" && item.assignment.shareWithinRole ? "pools.role" : "pools.user")}</span><span className="min-w-0 leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("ruleUsage", { used: format.number(item.rolling.used), limit: amount(item.rolling.rule.limit), pending: format.number(item.rolling.pending) })}{item.assignment.target.type === "mailbox" && item.assignment.lifetimeLimit >= 0 ? ` · ${t("lifetimeUsage", { used: format.number(item.lifetimeUsed), limit: amount(item.assignment.lifetimeLimit) })}` : ""}</span></div>)}</div>}
      <p className="text-xs text-muted-foreground">{t("allTime", { count: format.number(usage.allTimeCompleted) })}</p>
    </div>
  )
}

export function MyQuotaPanel() {
  const format = useFormatter()
  const t = useTranslations("profile.myQuotas")
  const [data, setData] = useState<SelfQuotaResponse | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void fetch("/api/access-policies/me", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) return setFailed(true)
      setData(await response.json() as SelfQuotaResponse)
    }).catch(error => { if (!(error instanceof Error && error.name === "AbortError")) setFailed(true) })
    return () => controller.abort()
  }, [])
  if (failed) return <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{t("loadFailed")}</div>
  if (!data?.access || !data.usage) return <div className="rounded border p-4 text-sm text-muted-foreground">{t("loading")}</div>
  const { access, usage } = data
  const amount = (value: number) => value <= 0 ? t("unlimited") : format.number(value)
  const general = [
    { key: "activeMailboxes", icon: Mail, value: t("usedOfLimit", { used: format.number(usage.activeMailboxes), limit: amount(access.quotas.maxActiveMailboxes) }) },
    { key: "mailboxLifetime", icon: Clock3, value: access.quotas.maxMailboxLifetimeDays === 0 ? t("unlimited") : t("days", { count: format.number(access.quotas.maxMailboxLifetimeDays) }) },
    { key: "messageBytes", icon: HardDrive, value: access.quotas.maxMessageBytes === 0 ? t("systemMaximum") : t("bytes", { count: format.number(access.quotas.maxMessageBytes) }) },
    { key: "activeApiKeys", icon: KeyRound, value: format.number(usage.activeApiKeys) },
  ] as const
  return <section className="min-w-0 space-y-3 rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5"><div className="min-w-0"><h2 className="flex min-w-0 items-center gap-2 font-semibold"><BarChart3 className="h-5 w-5 shrink-0 text-primary" /><span className="min-w-0 [overflow-wrap:anywhere]">{t("title")}</span></h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("description")}</p></div><div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">{general.map(({ key, icon: Icon, value }) => <div key={key} className="min-w-0 rounded-md border p-3"><div className="flex min-w-0 items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"><Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{t(`${key}.label` as never)}</span></div><div className="mt-1 min-w-0 font-semibold [overflow-wrap:anywhere]">{value}</div><p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t(`${key}.help` as never)}</p></div>)}</div><div className="grid min-w-0 gap-3 lg:grid-cols-2"><MailUsage direction="send" usage={usage.send} /><MailUsage direction="receive" usage={usage.receive} /></div><p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t("mailboxUsageHint")}</p></section>
}
