"use client"

import { AlertTriangle, CheckCircle2, Layers3, Route, ShieldCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import type { MailQuotaRuleRelations } from "@/lib/mail-quota-rule-relations"

export function MailQuotaRuleGuide() {
  const t = useTranslations("admin.access.mailQuota.guide")
  const items = [
    { key: "layers", icon: Layers3 },
    { key: "priority", icon: Route },
    { key: "safety", icon: ShieldCheck },
  ] as const
  return (
    <section className="space-y-2.5 rounded-md border border-primary/20 bg-primary/[0.04] p-3" aria-labelledby="mail-quota-guide-title">
      <div><h4 id="mail-quota-guide-title" className="text-sm font-medium">{t("title")}</h4><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("intro")}</p></div>
      <div className="grid min-w-0 gap-2 lg:grid-cols-3">
        {items.map(({ key, icon: Icon }) => <div key={key} className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 rounded border bg-background/70 p-2.5"><Icon className="mt-0.5 h-4 w-4 text-primary" /><div className="min-w-0"><p className="text-xs font-medium">{t(`${key}Title` as never)}</p><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{t(`${key}Description` as never)}</p></div></div>)}
      </div>
      <div className="rounded border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"><strong className="font-medium text-foreground">{t("exampleTitle")}</strong> {t("example")}</div>
    </section>
  )
}

export function MailQuotaCompatibility({ relations, unlimitedOverride }: {
  relations: MailQuotaRuleRelations
  unlimitedOverride: boolean
}) {
  const t = useTranslations("admin.access.mailQuota.compatibility")
  const duplicate = Boolean(relations.duplicateId)
  const warning = !duplicate && unlimitedOverride
  const notes: string[] = []
  if (duplicate) notes.push(t("duplicate"))
  else {
    if (relations.overrides > 0) notes.push(t("overrides", { count: relations.overrides }))
    if (relations.fallbacks > 0) notes.push(t("fallbacks", { count: relations.fallbacks }))
    if (relations.stacks > 0) notes.push(t("stacks", { count: relations.stacks }))
    if (relations.conditionalSubjectPriority > 0) notes.push(t("conditionalSubjectPriority", { count: relations.conditionalSubjectPriority }))
    if (unlimitedOverride) notes.push(t("unlimitedOverride"))
    if (notes.length === 0) notes.push(t("independent"))
  }
  const Icon = duplicate || warning ? AlertTriangle : CheckCircle2
  return (
    <div
      className={`rounded border p-2.5 text-xs ${duplicate ? "border-destructive/60 bg-destructive/10" : warning ? "border-amber-500/60 bg-amber-500/10" : "border-emerald-500/40 bg-emerald-500/[0.08]"}`}
      aria-live="polite"
    >
      <div className="flex min-w-0 items-start gap-2"><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${duplicate ? "text-destructive" : warning ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`} /><div className="min-w-0"><p className="font-medium">{duplicate ? t("conflictTitle") : warning ? t("warningTitle") : t("compatibleTitle")}</p><ul className="mt-1 space-y-0.5 leading-relaxed text-muted-foreground">{notes.map(note => <li key={note} className="[overflow-wrap:anywhere]">• {note}</li>)}</ul></div></div>
    </div>
  )
}
