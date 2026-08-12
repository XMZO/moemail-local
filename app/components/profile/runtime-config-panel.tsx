"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { parse, stringify } from "yaml"
import { AlertTriangle, CheckCircle2, FileCog, RefreshCw, RotateCcw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  runtimeConfigFields,
  runtimeGroupLabels,
  runtimeGroupOrder,
  type RuntimeFieldMetadata,
} from "./runtime-config-fields"

interface ConfigIssue { path: string; message: string }
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
  const kind = metadata.kind ?? (typeof defaultValue === "boolean" ? "boolean" : typeof defaultValue === "number" ? "number" : "text")
  const changed = JSON.stringify(value) !== JSON.stringify(defaultValue)

  return (
    <div className="rounded-md border bg-background/60 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div><Label className="text-sm">{metadata.label}</Label><p className="mt-0.5 text-xs leading-4 text-muted-foreground">{metadata.description}</p></div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={disabled || !changed} onClick={() => onChange(defaultValue)} title="恢复代码默认值"><RotateCcw className="h-3.5 w-3.5" /></Button>
      </div>
      {kind === "boolean" ? (
        <div className="flex h-9 items-center justify-between rounded border px-3"><code className="text-xs">{path}</code><Switch checked={Boolean(value)} onCheckedChange={onChange} disabled={disabled} /></div>
      ) : kind === "select" ? (
        <Select value={String(value)} onValueChange={onChange} disabled={disabled}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{metadata.options?.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>
      ) : kind === "textarea" ? (
        <Textarea value={value == null ? "" : String(value)} onChange={event => onChange(event.target.value || null)} disabled={disabled} spellCheck={false} className="min-h-28 font-mono text-xs" />
      ) : (
        <Input
          type={kind === "secret" ? "password" : kind === "number" ? "number" : "text"}
          value={value == null ? "" : String(value)}
          onChange={event => onChange(kind === "number" ? Number(event.target.value) : event.target.value || (defaultValue === null ? null : ""))}
          disabled={disabled}
          spellCheck={false}
          autoComplete={kind === "secret" ? "new-password" : undefined}
          className={kind === "secret" ? "font-mono" : undefined}
        />
      )}
      <code className="mt-1.5 block truncate text-[10px] text-muted-foreground" title={path}>{path}</code>
    </div>
  )
}

export function RuntimeConfigPanel() {
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
      if (!response.ok) throw new Error(body.error || "加载运行配置失败")
      applyResponse(body)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载运行配置失败")
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadConfig() }, [loadConfig])

  const groupedFields = useMemo(() => runtimeGroupOrder.map(group => ({
    group,
    fields: Object.entries(runtimeConfigFields).filter(([fieldPath]) => groupForPath(fieldPath) === group),
  })), [])

  const saveConfig = async () => {
    if (revision === null || !fingerprint || !config) return
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
        throw new Error(body.error || "配置未应用")
      }
      applyResponse(body)
      setMessage(body.restartRequired ? `配置已保存；${body.restartReason || "数据库类型变化需要重启"}` : "配置已保存并应用")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "配置未应用")
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
        throw new Error("配置顶层必须是键值对象")
      }
      setConfig(parsed as ConfigObject)
      setMode("visual")
    } catch (caught) {
      setError(`YAML 尚不能切换到视觉配置：${caught instanceof Error ? caught.message : "语法错误"}`)
    }
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><FileCog className="h-5 w-5 text-primary" /><div><h2 className="font-semibold">运行配置</h2><p className="text-xs text-muted-foreground">视觉表单与 YAML 使用同一份配置、校验和指纹 CAS。</p></div></div>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadConfig()} disabled={loading || saving}><RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} />重新加载</Button>
      </div>

      <div className="mb-4 rounded-md border border-destructive/70 bg-destructive/10 p-3 text-sm"><div className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><div><p className="font-medium text-destructive">此面板包含明文密钥</p><p className="text-xs text-muted-foreground">不要截图或复制给无关人员。数据库探测失败时新配置不会生效。</p></div></div></div>
      <div className="mb-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr] sm:gap-x-3"><span>文件</span><code className="break-all text-foreground">{path || "加载中…"}</code><span>运行修订</span><code className="text-foreground">{revision ?? "-"}</code><span>状态</span><span className="text-foreground">{status?.loadedFromFile ? "已加载" : status?.fileExists ? "尚未应用" : "不存在"}</span></div>
      {status?.restartRequired && <div className="mb-3 rounded border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{status.restartRequired.reason}</div>}
      {status?.lastError && <div className="mb-3 rounded border border-amber-500/60 bg-amber-500/10 p-3 text-sm"><p className="font-medium text-amber-700 dark:text-amber-300">最近一次热加载失败，仍使用上一份有效配置：</p><ul className="mt-1 space-y-1 text-xs">{status.lastError.issues.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code>: {issue.message}</li>)}</ul></div>}
      {conflict && <div className="mb-3 rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">配置已被其他窗口或文件编辑器更新，请重新加载后合并修改。</div>}
      {error && <div className="mb-3 rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {issues.length > 0 && <div className="mb-3 rounded border border-destructive/70 p-3 text-sm"><p className="font-medium text-destructive">校验问题</p><ul className="mt-1 space-y-1 text-xs">{issues.map((issue, index) => <li key={`${issue.path}-${index}`}><code>{issue.path}</code>: {issue.message}</li>)}</ul></div>}
      {message && <div className="mb-3 flex items-center gap-2 rounded border border-green-600/50 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300"><CheckCircle2 className="h-4 w-4" />{message}</div>}

      <Tabs value={mode} onValueChange={changeMode}>
        <TabsList><TabsTrigger value="visual">视觉配置</TabsTrigger><TabsTrigger value="yaml">原始 YAML</TabsTrigger></TabsList>
        <TabsContent value="visual" className="space-y-3 pt-1">
          {config && defaults && groupedFields.map(({ group, fields }, groupIndex) => (
            <details key={group} open={groupIndex < 4} className="rounded-md border bg-muted/20">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">{runtimeGroupLabels[group]} <span className="ml-1 text-xs font-normal text-muted-foreground">({fields.length})</span></summary>
              <div className="grid gap-3 border-t p-3 md:grid-cols-2 xl:grid-cols-3">
                {fields.map(([fieldPath, metadata]) => <RuntimeField key={fieldPath} path={fieldPath} metadata={metadata} value={getPath(config, fieldPath)} defaultValue={getPath(defaults, fieldPath)} disabled={disabled} onChange={value => setConfig(current => current ? setPath(current, fieldPath, value) : current)} />)}
              </div>
            </details>
          ))}
        </TabsContent>
        <TabsContent value="yaml"><Textarea value={yaml} onChange={event => setYaml(event.target.value)} disabled={disabled} aria-label="完整 YAML 运行配置" spellCheck={false} className="min-h-[34rem] resize-y whitespace-pre font-mono text-xs leading-5" /></TabsContent>
      </Tabs>

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">外部编辑仍会自动校验并热加载；数据库类型变化由守护进程重启后生效。</p><Button onClick={() => void saveConfig()} disabled={disabled}><Save className="mr-1 h-4 w-4" />{saving ? "校验并保存中" : "保存并应用"}</Button></div>
    </div>
  )
}
