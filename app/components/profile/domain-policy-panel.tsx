"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Globe2, Loader2, PlugZap, Plus, RotateCcw, Save, Trash2 } from "lucide-react"
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

type Inbound =
  | { mode: "worker" }
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
      pollIntervalSeconds: number
      maxMessagesPerPoll: number
    }
type Outbound =
  | { mode: "disabled" }
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
  pollIntervalSeconds: 60,
  maxMessagesPerPoll: 100,
})

export function DomainPolicyPanel() {
  const [policies, setPolicies] = useState<DomainPolicy[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testingImap, setTestingImap] = useState(false)
  const [testingSmtp, setTestingSmtp] = useState(false)
  const [error, setError] = useState("")
  const { toast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const response = await fetch("/api/config/domains", { cache: "no-store" })
      const body = await response.json() as { policies?: DomainPolicy[]; error?: string }
      if (!response.ok || !body.policies) throw new Error(body.error || "读取域名配置失败")
      setPolicies(body.policies)
      setSelected(index => Math.min(index, Math.max(0, body.policies!.length - 1)))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取域名配置失败")
    } finally {
      setLoading(false)
    }
  }, [])

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
      const body = await response.json() as { error?: string; mailbox?: string; messages?: number }
      if (!response.ok) throw new Error(body.error || "IMAP 连接测试失败")
      toast({ title: "IMAP 连接成功", description: `${body.mailbox ?? "INBOX"}：${body.messages ?? 0} 封邮件` })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "IMAP 连接测试失败")
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
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error || "SMTP 连接测试失败")
      toast({ title: "SMTP 连接与鉴权成功" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "SMTP 连接测试失败")
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
        issues?: Array<{ path: string; message: string }>
      }
      if (!response.ok || !body.policies) {
        const detail = body.issues?.map(issue => `${issue.path}: ${issue.message}`).join("；")
        throw new Error(detail || body.error || "保存域名配置失败")
      }
      setPolicies(body.policies)
      toast({ title: "域名收发策略已保存" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存域名配置失败")
    } finally {
      setSaving(false)
    }
  }

  const addDomain = () => {
    const suffix = policies.length + 1
    setPolicies(previous => [...previous, freshPolicy(`mail${suffix}.example.com`)])
    setSelected(policies.length)
  }

  const removeCurrent = () => {
    if (policies.length <= 1) return
    setPolicies(previous => previous.filter((_, index) => index !== selected))
    setSelected(index => Math.max(0, index - 1))
  }

  const modeSummary = useMemo(() => current
    ? `收件：${current.inbound.mode} · 发件：${current.outbound.mode}`
    : "",
  [current])

  if (loading) {
    return <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold"><Globe2 className="h-5 w-5 text-primary" />域名收发策略</div>
          <p className="mt-1 text-xs text-muted-foreground">每个域的收件与发件互相独立；密钥只返回给有配置权限的管理员。</p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={addDomain}><Plus className="mr-1 h-4 w-4" />添加</Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving}><Save className="mr-1 h-4 w-4" />{saving ? "保存中" : "保存"}</Button>
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
                <div><h3 className="font-medium">域与收件</h3><p className="text-xs text-muted-foreground">{modeSummary}</p></div>
                <Button type="button" variant="ghost" size="icon" onClick={removeCurrent} disabled={policies.length <= 1} title="删除当前域"><Trash2 className="h-4 w-4" /></Button>
              </div>
              <div className="space-y-2">
                <Label>邮箱域名</Label>
                <Input value={current.domain} onChange={event => updateCurrent(policy => ({ ...policy, domain: event.target.value }))} spellCheck={false} />
              </div>
              <div className="space-y-2">
                <Label>收件方式</Label>
                <Select value={current.inbound.mode} onValueChange={mode => setInboundMode(mode as Inbound["mode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="worker">Cloudflare Email Worker</SelectItem>
                    <SelectItem value="imap">外部邮箱 IMAP</SelectItem>
                    <SelectItem value="disabled">关闭收件</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {current.inbound.mode === "imap" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label>IMAP 主机</Label><Input value={current.inbound.host} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), host: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>端口</Label><Input type="number" min={1} max={65535} value={current.inbound.port} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), port: Number(event.target.value) } }))} /></div>
                  <div className="space-y-2"><Label>安全模式</Label><Select value={current.inbound.security} onValueChange={security => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), security: security as "plain" | "starttls" | "tls" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="tls">TLS（通常 993）</SelectItem><SelectItem value="starttls">STARTTLS（通常 143）</SelectItem><SelectItem value="plain">明文</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>邮箱文件夹</Label><Input value={current.inbound.mailbox} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), mailbox: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>用户名</Label><Input autoComplete="username" value={current.inbound.username} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), username: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>密码或应用专用密码</Label><Input type="password" autoComplete="new-password" value={current.inbound.password} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), password: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>本地地址 Header</Label><Select value={current.inbound.recipientHeader} onValueChange={recipientHeader => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), recipientHeader: recipientHeader as Extract<Inbound, { mode: "imap" }>["recipientHeader"] } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">自动检测投递追踪头（推荐）</SelectItem><SelectItem value="x-original-to">X-Original-To</SelectItem><SelectItem value="delivered-to">Delivered-To</SelectItem><SelectItem value="envelope-to">Envelope-To</SelectItem><SelectItem value="x-envelope-to">X-Envelope-To</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>首次同步</Label><Select value={current.inbound.initialSync} onValueChange={initialSync => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), initialSync: initialSync as "new" | "unseen" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="new">仅保存后新邮件（推荐）</SelectItem><SelectItem value="unseen">同时导入未读邮件</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>轮询间隔（秒）</Label><Input type="number" min={15} max={86400} value={current.inbound.pollIntervalSeconds} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), pollIntervalSeconds: Number(event.target.value) } }))} /></div>
                  <div className="space-y-2"><Label>每轮最多邮件</Label><Input type="number" min={1} max={1000} value={current.inbound.maxMessagesPerPoll} onChange={event => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), maxMessagesPerPoll: Number(event.target.value) } }))} /></div>
                  <div className="flex items-center justify-between gap-3 rounded border p-3 sm:col-span-2"><div><Label>严格校验证书</Label><p className="text-xs text-muted-foreground">公共邮局请保持开启。</p></div><Switch checked={current.inbound.rejectUnauthorized} onCheckedChange={rejectUnauthorized => updateCurrent(policy => ({ ...policy, inbound: { ...(policy.inbound as Extract<Inbound, { mode: "imap" }>), rejectUnauthorized } }))} /></div>
                  <div className="sm:col-span-2"><Button type="button" variant="outline" size="sm" onClick={() => void testImap()} disabled={testingImap}><PlugZap className="mr-1 h-4 w-4" />{testingImap ? "连接中" : "测试 IMAP 连接"}</Button></div>
                  <p className="text-xs text-muted-foreground sm:col-span-2">轮询以只读方式访问邮箱，不标记已读、不移动也不删除邮件。别名/全域转发必须保留能识别原始收件人的 Header。</p>
                </div>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => updateCurrent(() => freshPolicy(current.domain))}>
                <RotateCcw className="mr-1 h-4 w-4" />重置此域
              </Button>
            </section>

            <section className="space-y-4 rounded-md border p-4">
              <div><h3 className="font-medium">发件</h3><p className="text-xs text-muted-foreground">Resend API Key 与 SMTP 凭据按域保存。</p></div>
              <div className="space-y-2">
                <Label>发件方式</Label>
                <Select value={current.outbound.mode} onValueChange={mode => setOutboundMode(mode as Outbound["mode"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="resend">Resend</SelectItem>
                    <SelectItem value="smtp">外部 SMTP</SelectItem>
                    <SelectItem value="disabled">关闭发件</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {current.outbound.mode === "resend" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2 sm:col-span-2"><Label>Resend API Key</Label><Input type="password" autoComplete="new-password" value={current.outbound.apiKey} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "resend" }>), apiKey: event.target.value } }))} /></div>
                  <div className="space-y-2 sm:col-span-2"><Label>发件人名称（可选）</Label><Input value={current.outbound.fromName ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "resend" }>), fromName: event.target.value || null } }))} /></div>
                </div>
              )}

              {current.outbound.mode === "smtp" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2"><Label>SMTP 主机</Label><Input value={current.outbound.host} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), host: event.target.value } }))} /></div>
                  <div className="space-y-2"><Label>端口</Label><Input type="number" min={1} max={65535} value={current.outbound.port} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), port: Number(event.target.value) } }))} /></div>
                  <div className="space-y-2"><Label>安全模式</Label><Select value={current.outbound.security} onValueChange={security => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), security: security as "plain" | "starttls" | "tls" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="starttls">STARTTLS</SelectItem><SelectItem value="tls">TLS</SelectItem><SelectItem value="plain">明文</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>认证方式</Label><Select value={current.outbound.authMethod} onValueChange={authMethod => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), authMethod: authMethod as "auto" | "plain" | "login" } }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">自动协商（推荐）</SelectItem><SelectItem value="plain">强制 PLAIN</SelectItem><SelectItem value="login">强制 LOGIN（Microsoft/Outlook 等）</SelectItem></SelectContent></Select></div>
                  <div className="space-y-2"><Label>发件人名称（可选）</Label><Input value={current.outbound.fromName ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), fromName: event.target.value || null } }))} /></div>
                  <div className="space-y-2"><Label>用户名（可选）</Label><Input value={current.outbound.username ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), username: event.target.value || null } }))} /></div>
                  <div className="space-y-2"><Label>密码（可选）</Label><Input type="password" autoComplete="new-password" value={current.outbound.password ?? ""} onChange={event => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), password: event.target.value || null } }))} /></div>
                  <div className="flex items-center justify-between gap-3 rounded border p-3 sm:col-span-2"><div><Label>严格校验证书</Label><p className="text-xs text-muted-foreground">生产环境建议保持开启。</p></div><Switch checked={current.outbound.rejectUnauthorized} onCheckedChange={rejectUnauthorized => updateCurrent(policy => ({ ...policy, outbound: { ...(policy.outbound as Extract<Outbound, { mode: "smtp" }>), rejectUnauthorized } }))} /></div>
                  <div className="sm:col-span-2"><Button type="button" variant="outline" size="sm" onClick={() => void testSmtp()} disabled={testingSmtp}><PlugZap className="mr-1 h-4 w-4" />{testingSmtp ? "连接中" : "测试 SMTP 连接"}</Button></div>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
