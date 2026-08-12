"use client"

import { useEffect, useState } from "react"
import { RotateCcw, Save, Type } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"

const presets = [
  { label: "默认像素字体", value: "var(--font-zpix), sans-serif" },
  { label: "系统无衬线", value: "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif" },
  { label: "系统等宽", value: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { label: "系统衬线", value: "ui-serif, Georgia, Cambria, serif" },
]

export function AppearancePanel() {
  const [fontFamily, setFontFamily] = useState("")
  const [defaultFontFamily, setDefaultFontFamily] = useState(presets[0].value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const { toast } = useToast()

  useEffect(() => {
    void fetch("/api/config/appearance", { cache: "no-store" })
      .then(async response => {
        const body = await response.json() as { fontFamily?: string; defaultFontFamily?: string; error?: string }
        if (!response.ok || !body.fontFamily) throw new Error(body.error || "读取字体配置失败")
        setFontFamily(body.fontFamily)
        setDefaultFontFamily(body.defaultFontFamily || presets[0].value)
      })
      .catch(caught => setError(caught instanceof Error ? caught.message : "读取字体配置失败"))
  }, [])

  const save = async (next = fontFamily) => {
    setSaving(true)
    setError("")
    try {
      const response = await fetch("/api/config/appearance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fontFamily: next }),
      })
      const body = await response.json() as { fontFamily?: string; error?: string }
      if (!response.ok || !body.fontFamily) throw new Error(body.error || "保存字体配置失败")
      setFontFamily(body.fontFamily)
      toast({ title: "全站字体已保存", description: "刷新页面后所有服务端页面都会使用新字体。" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存字体配置失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border-2 border-primary/20 bg-background p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2"><Type className="h-5 w-5 text-primary" /><div><h2 className="font-semibold">全站字体</h2><p className="text-xs text-muted-foreground">填写 CSS font-family；只接受安全的字体名称与回退列表。</p></div></div>
      {error && <div className="mb-3 rounded border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="space-y-2"><Label>字体族</Label><Input value={fontFamily} onChange={event => setFontFamily(event.target.value)} spellCheck={false} /><div className="flex flex-wrap gap-2">{presets.map(preset => <Button key={preset.label} type="button" variant="outline" size="sm" onClick={() => setFontFamily(preset.value)}>{preset.label}</Button>)}</div></div>
        <div className="rounded border p-3" style={{ fontFamily }}><p className="text-xs text-muted-foreground">预览</p><p className="mt-2 text-lg">MoeMail 邮箱 Aa 123</p><p className="text-sm">简洁、可靠、可自托管。</p></div>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => { setFontFamily(defaultFontFamily); void save(defaultFontFamily) }} disabled={saving}><RotateCcw className="mr-1 h-4 w-4" />恢复默认</Button><Button onClick={() => void save()} disabled={saving || !fontFamily}><Save className="mr-1 h-4 w-4" />保存</Button></div>
    </div>
  )
}
