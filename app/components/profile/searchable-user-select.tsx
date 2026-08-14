"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2, Search } from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type SearchableUser = {
  id: string
  name: string | null
  username: string | null
  email: string | null
  role: string | null
  accessOverride?: unknown
}

function userIdentity(user: SearchableUser) {
  return user.name || user.username || user.email || user.id
}

export function SearchableUserSelect({ value, onValueChange, knownUsers = [], onUserResolved, className = "" }: {
  value: string
  onValueChange: (value: string) => void
  knownUsers?: SearchableUser[]
  onUserResolved?: (user: SearchableUser) => void
  className?: string
}) {
  const t = useTranslations("admin.access.userPicker")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchableUser[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const search = query.trim()
    if (!search) {
      setResults([])
      setLoading(false)
      setFailed(false)
      return
    }
    const controller = new AbortController()
    setResults([])
    setLoading(true)
    setFailed(false)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ page: "1", pageSize: "50" })
      params.set("search", search)
      void fetch(`/api/roles/users?${params}`, { cache: "no-store", signal: controller.signal })
        .then(async response => {
          const body = await response.json() as { users?: SearchableUser[] }
          if (!response.ok || !body.users) return Promise.reject()
          setResults(body.users)
        })
        .catch(error => {
          if (error instanceof Error && error.name === "AbortError") return
          setResults([])
          setFailed(true)
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])

  const options = useMemo(() => {
    const byId = new Map<string, SearchableUser>()
    const selected = knownUsers.find(user => user.id === value)
    if (selected) byId.set(selected.id, selected)
    for (const user of query.trim() ? results : knownUsers) byId.set(user.id, user)
    return [...byId.values()]
  }, [knownUsers, query, results, value])

  const select = (id: string) => {
    const user = options.find(candidate => candidate.id === id)
    if (user) onUserResolved?.(user)
    onValueChange(id)
  }

  return (
    <div className={`min-w-0 space-y-2 ${className}`}>
      <div className="relative min-w-0">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="h-8 min-w-0 pl-8 pr-8" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("search")} maxLength={200} autoComplete="off" />
        {loading && <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-primary" />}
      </div>
      <Select value={value} onValueChange={select}>
        <SelectTrigger className="h-8 min-w-0 gap-2 [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"><SelectValue placeholder={t("select")} /></SelectTrigger>
        <SelectContent>
          {options.map(user => <SelectItem key={user.id} value={user.id}>{userIdentity(user)}</SelectItem>)}
          {!loading && options.length === 0 && <div className="px-2 py-3 text-center text-xs text-muted-foreground">{failed ? t("error") : t("empty")}</div>}
        </SelectContent>
      </Select>
    </div>
  )
}
