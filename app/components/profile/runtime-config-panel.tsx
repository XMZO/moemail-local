"use client"

import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  FileCog,
  RefreshCw,
  Save,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface ConfigIssue {
  path: string
  message: string
}

interface ConfigStatus {
  fileExists: boolean
  loadedFromFile: boolean
  lastError: { at: string; issues: ConfigIssue[] } | null
  restartRequired: { at: string; reason: string } | null
}

interface RuntimeConfigResponse {
  yaml: string
  fingerprint: string
  revision: number
  path: string
  status: ConfigStatus
  restartRequired?: boolean
  restartReason?: string | null
}

interface ErrorResponse {
  error?: string
  issues?: ConfigIssue[]
}

export function RuntimeConfigPanel() {
  const [yaml, setYaml] = useState("")
  const [revision, setRevision] = useState<number | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [path, setPath] = useState("")
  const [status, setStatus] = useState<ConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [conflict, setConflict] = useState(false)

  const loadConfig = async () => {
    setLoading(true)
    setError("")
    setIssues([])
    setConflict(false)
    setMessage("")

    try {
      const response = await fetch("/api/runtime-config", { cache: "no-store" })
      const body = await response.json() as RuntimeConfigResponse & ErrorResponse
      if (!response.ok) throw new Error(body.error || "加载运行配置失败")

      setYaml(body.yaml)
      setRevision(body.revision)
      setFingerprint(body.fingerprint)
      setPath(body.path)
      setStatus(body.status)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载运行配置失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadConfig()
  }, [])

  const saveConfig = async () => {
    if (revision === null || fingerprint === null) return

    setSaving(true)
    setError("")
    setIssues([])
    setConflict(false)
    setMessage("")

    try {
      const response = await fetch("/api/runtime-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yaml, fingerprint }),
      })
      const body = await response.json() as RuntimeConfigResponse & ErrorResponse

      if (!response.ok) {
        setConflict(response.status === 409)
        setIssues(body.issues ?? [])
        throw new Error(body.error || "配置未应用")
      }

      setYaml(body.yaml)
      setRevision(body.revision)
      setFingerprint(body.fingerprint)
      setPath(body.path)
      setStatus(body.status)
      setMessage(body.restartRequired
        ? `配置已保存；${body.restartReason || "数据库类型变化需要重启进程"}`
        : "配置已保存并应用")
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "配置未应用")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-background rounded-lg border-2 border-primary/20 p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileCog className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">运行配置文件</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadConfig()}
          disabled={loading || saving}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          重新加载
        </Button>
      </div>

      <div className="mb-4 rounded-md border-2 border-destructive bg-destructive/10 p-4 text-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="font-semibold text-destructive">警告：下方是包含明文密钥的完整配置</p>
            <p className="text-muted-foreground">
              请勿截图、复制到聊天或交给无关人员。保存前会校验完整 YAML；校验或数据库探测失败时不会应用新配置。
            </p>
          </div>
        </div>
      </div>

      <div className="mb-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr] sm:gap-x-3">
        <span>文件路径</span>
        <code className="break-all text-foreground">{path || "加载中…"}</code>
        <span>进程内运行修订号</span>
        <code className="text-foreground">{revision ?? "-"}</code>
        <span>运行状态</span>
        <span className="text-foreground">
          {status?.loadedFromFile
            ? "已从配置文件加载"
            : status?.fileExists ? "尚未应用" : "配置文件不存在"}
        </span>
      </div>

      {status?.restartRequired && (
        <div className="mb-3 rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          {status.restartRequired.reason}
        </div>
      )}

      {status?.lastError && (
        <div className="mb-3 rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            文件最近一次热加载失败，当前仍在使用上一份有效配置：
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {status.lastError.issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <code>{issue.path}</code>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {conflict && (
        <div className="mb-3 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          配置已在其他窗口或文件编辑器中更新。当前内容未保存，请先重新加载后再合并修改。
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {issues.length > 0 && (
        <div className="mb-3 rounded-md border border-destructive/70 p-3 text-sm">
          <p className="font-medium text-destructive">校验问题</p>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                <code className="text-foreground">{issue.path}</code>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {message && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-green-600/50 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {message}
        </div>
      )}

      <Textarea
        value={yaml}
        onChange={event => setYaml(event.target.value)}
        disabled={loading || saving || revision === null || fingerprint === null}
        aria-label="完整 YAML 运行配置"
        spellCheck={false}
        className="min-h-[34rem] resize-y whitespace-pre font-mono text-xs leading-5"
        placeholder={loading ? "正在加载配置…" : "在此编辑完整 YAML 配置"}
      />

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          外部编辑文件也会自动校验并热加载；数据库类型切换可能触发进程重启。
        </p>
        <Button
          type="button"
          onClick={() => void saveConfig()}
          disabled={loading || saving || revision === null || fingerprint === null}
          className="gap-2"
        >
          <Save className="h-4 w-4" />
          {saving ? "正在校验并保存…" : "保存并应用"}
        </Button>
      </div>
    </div>
  )
}
