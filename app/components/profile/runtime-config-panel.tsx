"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { nanoid } from "nanoid"
import { useFormatter, useTranslations } from "next-intl"
import { parse, stringify } from "yaml"
import { AlertTriangle, CheckCircle2, Dices, Eye, EyeOff, FileCog, RefreshCw, RotateCcw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { LocalizedUiError, localizedUiErrorMessage } from "@/lib/localized-ui-error"
import {
  runtimeConfigFields,
  runtimeGroupOrder,
  type RuntimeFieldMetadata,
} from "./runtime-config-fields"

interface ConfigIssue { path: string; code?: string }
interface ConfigStatus {
  fileExists: boolean
  loadedFromFile: boolean
  lastError: { at: string; issues: ConfigIssue[] } | null
  restartRequired: { at: string; reason: string } | null
}
type ConfigObject = Record<string, unknown>
interface RuntimeConfigResponse {
  yaml: string
  config: ConfigObject
  defaults: ConfigObject
  fingerprint: string
  revision: number
  path: string
  status: ConfigStatus
  restartRequired?: boolean
  restartReason?: string | null
  error?: string
  issues?: ConfigIssue[]
}

function getPath(root: ConfigObject, path: string) {
  return path.split(".").reduce<unknown>((value, key) => (
    typeof value === "object" && value !== null ? (value as ConfigObject)[key] : undefined
  ), root)
}

function setPath(root: ConfigObject, path: string, value: unknown) {
  const clone = structuredClone(root)
  const segments = path.split(".")
  let cursor = clone
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as ConfigObject
  }
  cursor[segments.at(-1)!] = value
  return clone
}

function groupForPath(path: string) {
  return path.includes(".") ? path.split(".")[0] : "root"
}

function RuntimeField({
  path,
  metadata,
  value,
  defaultValue,
  disabled,
  onChange,
}: {
  path: string
  metadata: RuntimeFieldMetadata
  value: unknown
  defaultValue: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const t = useTranslations("runtime")
  const [secretVisible, setSecretVisible] = useState(false)
  const kind = metadata.kind ?? (typeof defaultValue === "boolean" ? "boolean" : typeof defaultValue === "number" ? "number" : "text")
  const changed = JSON.stringify(value) !== JSON.stringify(defaultValue)
  const requiredMissing = metadata.required && (value === null || value === undefined || String(value).trim() === "")
  const canRestoreDefault = kind !== "secret"
  const canGenerateSecret = kind === "secret" && metadata.secretAction === "generate"
  const label = t(`fields.${path}.label` as never)
  const description = t(`fields.${path}.description` as never)

  return (
    <div className="rounded-md border bg-background/60 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div><Label className="text-sm">{label}{metadata.required && <span className="ml-0.5 text-destructive">*</span>}</Label><p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p></div>
        {canGenerateSecret ? (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={disabled} onClick={() => onChange(nanoid(43))} title={t("actions.generate")} aria-label={t("actions.generateFor", { label })}><Dices className="h-3.5 w-3.5" /></Button>
        ) : canRestoreDefault ? (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={disabled || !changed} onClick={() => onChange(defaultValue)} title={t("actions.restoreDefault")}><RotateCcw className="h-3.5 w-3.5" /></Button>
        ) : null}
      </div>
      {kind === "boolean" ? (
        <div className="flex h-9 items-center justify-between rounded border px-3"><code className="text-xs">{path}</code><Switch checked={Boolean(value)} onCheckedChange={onChange} disabled={disabled} /></div>
      ) : kind === "select" ? (
        <Select value={String(value)} onValueChange={onChange} disabled={disabled}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{metadata.options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>
      ) : kind === "textarea" ? (
        <Textarea value={value == null ? "" : String(value)} onChange={event => onChange(event.target.value || null)} disabled={disabled} spellCheck={false} className="min-h-28 font-mono text-xs" />
      ) : kind === "secret" ? (
        <div className="relative">
          <Input
            type={secretVisible ? "text" : "password"}
            value={value == null ? "" : String(value)}
            onChange={event => onChange(event.target.value || (defaultValue === null ? null : ""))}
            disabled={disabled}
            spellCheck={false}
            autoComplete="new-password"
            aria-invalid={requiredMissing}
            className="pr-10 font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full w-10 hover:bg-transparent"
            disabled={disabled}
            onClick={() => setSecretVisible(visible => !visible)}
            title={secretVisible ? t("actions.hide", { label }) : t("actions.show", { label })}
            aria-label={secretVisible ? t("actions.hide", { label }) : t("actions.show", { label })}
          >
            {secretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      ) : (
        <Input
          type={kind === "number" ? "number" : "text"}
          value={value == null ? "" : String(value)}
          onChange={event => onChange(kind === "number" ? Number(event.target.value) : event.target.value || (defaultValue === null ? null : ""))}
          disabled={disabled}
          spellCheck={false}
        />
      )}
      {requiredMissing && <p className="mt-1.5 text-xs text-destructive">{t("required")}</p>}
      <code className="mt-1.5 block truncate text-[10px] text-muted-foreground" title={path}>{path}</code>
    </div>
  )
}

export function RuntimeConfigPanel() {
  const format = useFormatter()
  const t = useTranslations("runtime")
  const tApi = useTranslations("api")
  const [yaml, setYaml] = useState("")
  const [config, setConfig] = useState<ConfigObject | null>(null)
  const [defaults, setDefaults] = useState<ConfigObject | null>(null)
  const [revision, setRevision] = useState<number | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [path, setFilePath] = useState("")
  const [status, setStatus] = useState<ConfigStatus | null>(null)
  const [mode, setMode] = useState("visual")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [conflict, setConflict] = useState(false)

  const applyResponse = (body: RuntimeConfigResponse) => {
    setYaml(body.yaml)
    setConfig(body.config)
    setDefaults(body.defaults)
    setRevision(body.revision)
    setFingerprint(body.fingerprint)
    setFilePath(body.path)
    setStatus(body.status)
  }

  const loadConfig = useCallback(async () => {
    setLoading(true); setError(""); setIssues([]); setConflict(false); setMessage("")
    try {
      const response = await fetch("/api/runtime-config", { cache: "no-store" })
      const body = await response.json() as RuntimeConfigResponse
      if (!response.ok) {
        throw new LocalizedUiError(body.error && tApi.has(body.error as never)
          ? tApi(body.error as never)
          : t("errors.load"))
      }
      applyResponse(body)
    } catch (caught) {
      console.error("runtime_config.load_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.load")))
    } finally { setLoading(false) }
  }, [t, tApi])

  useEffect(() => { void loadConfig() }, [loadConfig])

  const groupedFields = useMemo(() => runtimeGroupOrder.map(group => ({
    group,
    fields: Object.entries(runtimeConfigFields).filter(([fieldPath]) => groupForPath(fieldPath) === group),
  })), [])

  const missingRequiredFields = useMemo(() => config
    ? Object.entries(runtimeConfigFields).filter(([fieldPath, metadata]) => {
      if (!metadata.required) return false
      const value = getPath(config, fieldPath)
      return value === null || value === undefined || String(value).trim() === ""
    })
    : [], [config])
  const formattedRequiredFields = format.list(
    missingRequiredFields.map(([fieldPath]) => t(`fields.${fieldPath}.label` as never)),
    { type: "unit" },
  )

  const saveConfig = async () => {
    if (revision === null || !fingerprint || !config) return
    if (mode === "visual" && missingRequiredFields.length > 0) {
      setError(t("requiredSecrets", { fields: formattedRequiredFields }))
      return
    }
    setSaving(true); setError(""); setIssues([]); setConflict(false); setMessage("")
    try {
      const response = await fetch("/api/runtime-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "yaml" ? { yaml, fingerprint } : { config, fingerprint }),
      })
      const body = await response.json() as RuntimeConfigResponse
      if (!response.ok) {
        setConflict(response.status === 409)
        setIssues(body.issues ?? [])
        throw new LocalizedUiError(body.error && tApi.has(body.error as never)
          ? tApi(body.error as never)
          : t("errors.save"))
      }
      applyResponse(body)
      setMessage(body.restartRequired ? t("success.restart", { reason: t("success.driverRestart") }) : t("success.applied"))
    } catch (caught) {
      console.error("runtime_config.save_failed", caught)
      setError(localizedUiErrorMessage(caught, t("errors.save")))
    } finally { setSaving(false) }
  }

  const disabled = loading || saving || revision === null || !fingerprint || !config || !defaults

  const changeMode = (nextMode: string) => {
    if (nextMode === mode) return
    setError("")
    setIssues([])

    if (nextMode === "yaml") {
      if (config) setYaml(stringify(config, { lineWidth: 0 }))
      setMode("yaml")
      return
    }

    try {
      const parsed = parse(yaml, { prettyErrors: false }) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new LocalizedUiError(t("errors.notObject"))
      }
      setConfig(parsed as ConfigObject)
      setMode("visual")
    } catch (caught) {
      console.error("runtime_config.yaml_parse_failed", caught)
      setError(t("errors.yamlSwitch", { reason: t("errors.syntax") }))
    }
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><FileCog className="h-5 w-5 text-primary" /><div><h2 className="font-semibold">{t("title")}</h2><p className="text-xs text-muted-foreground">{t("description")}</p></div></div>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadConfig()} disabled={loading || saving}><RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />{t("reload")}</Button>
      </div>

      <div className="mb-4 rounded-md border border-destructive/70 bg-destructive/10 p-3 text-sm"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div><p className="font-medium text-destructive">{t("secretWarningTitle")}</p><p className="text-xs text-muted-foreground">{t("secretWarningDescription")}</p></div></div></div>
      <div className="mb-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr] sm:gap-x-3"><span>{t("file")}</span><code className="break-all text-foreground">{path || t("loading")}</code><span>{t("revision")}</span><code className="text-foreground">{revision ?? "-"}</code><span>{t("status")}</span><span className="text-foreground">{status?.loadedFromFile ? t("statusLoaded") : status?.fileExists ? t("statusPending") : t("statusMissing")}</span></div>
      {status?.restartRequired && <div className="mb-3 rounded border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{t("success.driverRestart")}</div>}
      {status?.lastError && <div className="mb-3 rounded border border-amber-500/60 bg-amber-500/10 p-3 text-sm"><p className="font-medium text-amber-700 dark:text-amber-300">{t("lastError")}</p><ul className="mt-1 space-y-1 text-xs">{status.lastError.issues.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code></li>)}</ul></div>}
      {conflict && <div className="mb-3 rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">{t("conflict")}</div>}
      {error && <div className="mb-3 rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {issues.length > 0 && <div className="mb-3 rounded border border-destructive/70 p-3 text-sm"><p className="font-medium text-destructive">{t("validationIssues")}</p><ul className="mt-1 space-y-1 text-xs">{issues.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code></li>)}</ul></div>}
      {mode === "visual" && missingRequiredFields.length > 0 && <div className="mb-3 rounded border border-destructive/70 bg-destructive/10 p-3 text-sm text-destructive">{t("requiredSecrets", { fields: formattedRequiredFields })}</div>}
      {message && <div className="mb-3 flex items-center gap-2 rounded border border-green-600/50 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300"><CheckCircle2 className="h-4 w-4" />{message}</div>}

      <Tabs value={mode} onValueChange={changeMode}>
        <TabsList><TabsTrigger value="visual">{t("visual")}</TabsTrigger><TabsTrigger value="yaml">{t("yaml")}</TabsTrigger></TabsList>
        <TabsContent value="visual" className="space-y-3 pt-1">
          {config && defaults && groupedFields.map(({ group, fields }) => (
            <details key={group} className="rounded-md border bg-muted/20">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">{t(`groups.${group}` as never)} <span className="ml-1 text-xs font-normal text-muted-foreground">({fields.length})</span></summary>
              <div className="grid gap-3 border-t p-3 md:grid-cols-2 xl:grid-cols-3">
                {fields.map(([fieldPath, metadata]) => <RuntimeField key={fieldPath} path={fieldPath} metadata={metadata} value={getPath(config, fieldPath)} defaultValue={getPath(defaults, fieldPath)} disabled={disabled} onChange={value => setConfig(current => current ? setPath(current, fieldPath, value) : current)} />)}
              </div>
            </details>
          ))}
        </TabsContent>
        <TabsContent value="yaml"><Textarea value={yaml} onChange={event => setYaml(event.target.value)} disabled={disabled} aria-label={t("yamlAria")} spellCheck={false} className="min-h-[34rem] resize-y whitespace-pre font-mono text-xs leading-5" /></TabsContent>
      </Tabs>

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">{t("externalEditHint")}</p><Button onClick={() => void saveConfig()} disabled={disabled || (mode === "visual" && missingRequiredFields.length > 0)}><Save className="mr-1 h-4 w-4" />{saving ? t("saving") : t("save")}</Button></div>
    </div>
  )
}
