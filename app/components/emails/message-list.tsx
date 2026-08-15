"use client"

import { useState, useEffect, useRef } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {Mail, Calendar, RefreshCw, Trash2, Share2} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useThrottle } from "@/hooks/use-throttle"
import { readApiErrorCode } from "@/lib/api-error-client"
import { useRuntimeConfig } from "@/providers"
import { useToast } from "@/components/ui/use-toast"
import { ShareMessageDialog } from "./share-message-dialog"
import { useRolePermission } from "@/hooks/use-role-permission"
import { PERMISSIONS } from "@/lib/permissions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  received_at?: number
  sent_at?: number
  content?: string
  html?: string
}

interface MessageListProps {
  email: {
    id: string
    address: string
  }
  messageType: 'received' | 'sent'
  onMessageSelect: (messageId: string | null, messageType?: 'received' | 'sent') => void
  selectedMessageId?: string | null
  refreshTrigger?: number
}

interface MessageResponse {
  messages: Message[]
  nextCursor: string | null
  total?: number
}

interface AppliedQuotaCounter {
  rolling: { remaining: number | null }
  lifetimeRemaining: number | null
}

interface MailboxQuotaResponse {
  send?: { allowed: boolean; error?: string; quota?: { applied?: AppliedQuotaCounter[] } }
  receive?: { allowed: boolean; error?: string; quota?: { applied?: AppliedQuotaCounter[] } }
}

export function MessageList({ email, messageType, onMessageSelect, selectedMessageId, refreshTrigger }: MessageListProps) {
  const format = useFormatter()
  const t = useTranslations("emails.messages")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const tFormat = useTranslations("common.format")
  const tApi = useTranslations("api")
  const { emailPollIntervalMs: pollIntervalMs } = useRuntimeConfig()
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const pollTimeoutRef = useRef<Timer>(null)
  const messagesRef = useRef<Message[]>([]) // 添加 ref 来追踪最新的消息列表
  const [total, setTotal] = useState(0)
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null)
  const [quota, setQuota] = useState<MailboxQuotaResponse | null>(null)
  const { toast } = useToast()
  const { checkPermission } = useRolePermission()
  const canShare = checkPermission(PERMISSIONS.SHARE_EMAIL)
  const canDelete = checkPermission(PERMISSIONS.DELETE_EMAIL)

  const fetchQuota = async () => {
    try {
      const response = await fetch(`/api/emails/${email.id}/quota`, { cache: "no-store" })
      if (!response.ok) {
        await readApiErrorCode(response, "MAIL_QUOTA_USAGE_READ_FAILED")
        return
      }
      setQuota(await response.json() as MailboxQuotaResponse)
    } catch (error) {
      console.error("mailbox.quota_fetch_failed", error)
    }
  }

  // 当 messages 改变时更新 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const fetchMessages = async (cursor?: string, includeTotal = false) => {
    try {
      const url = new URL(`/api/emails/${email.id}`, window.location.origin)
      if (messageType === 'sent') {
        url.searchParams.set('type', 'sent')
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }
      if (includeTotal) {
        url.searchParams.set('includeTotal', '1')
      }
      const response = await fetch(url)
      if (!response.ok) {
        await readApiErrorCode(response, "MESSAGES_READ_FAILED")
        return
      }
      const data = await response.json() as MessageResponse
      if (!Array.isArray(data.messages)) {
        console.error("message.list_invalid_response")
        return
      }
      
      if (!cursor) {
        const newMessages = data.messages
        const oldMessages = messagesRef.current

        const lastDuplicateIndex = newMessages.findIndex(
          newMsg => oldMessages.some(oldMsg => oldMsg.id === newMsg.id)
        )

        if (lastDuplicateIndex === -1) {
          setMessages(newMessages)
          setNextCursor(data.nextCursor)
          setTotal(data.total ?? newMessages.length)
          void fetchQuota()
          return
        }
        const uniqueNewMessages = newMessages.slice(0, lastDuplicateIndex)
        setMessages([...uniqueNewMessages, ...oldMessages])
        setTotal(current => data.total ?? current + uniqueNewMessages.length)
        if (uniqueNewMessages.length > 0) void fetchQuota()
        return
      }
      setMessages(prev => [...prev, ...data.messages])
      setNextCursor(data.nextCursor)
      if (data.total !== undefined) {
        setTotal(data.total)
      }
    } catch (error) {
      console.error("message.list_fetch_failed", error)
    } finally {
      setLoading(false)
      setRefreshing(false)
      setLoadingMore(false)
    }
  }

  const startPolling = () => {
    stopPolling()
    pollTimeoutRef.current = setInterval(() => {
      if (!refreshing && !loadingMore) {
        fetchMessages()
      }
    }, pollIntervalMs)
  }

  const stopPolling = () => {
    if (pollTimeoutRef.current) {
      clearInterval(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchMessages(undefined, true)
  }

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold && nextCursor) {
      setLoadingMore(true)
      fetchMessages(nextCursor)
    }
  }, 200)

  const handleDelete = async (message: Message) => {
    try {
      const response = await fetch(`/api/emails/${email.id}/${message.id}${messageType === 'sent' ? '?type=sent' : ''}`, {
        method: "DELETE"
      })

      if (!response.ok) {
        const code = await readApiErrorCode(response, "MESSAGE_DELETE_FAILED")
        toast({
          title: tList("error"),
          description: tApi.has(code as never) ? tApi(code as never) : tList("deleteFailed"),
          variant: "destructive"
        })
        return
      }

      setMessages(prev => prev.filter(e => e.id !== message.id))
      setTotal(prev => prev - 1)

      toast({
        title: tList("success"),
        description: tList("deleteSuccess")
      })

      if (selectedMessageId === message.id) {
        onMessageSelect(null)
      }
    } catch {
      toast({
        title: tList("error"),
        description: tList("deleteFailed"),
        variant: "destructive"
      })
    } finally {
      setMessageToDelete(null)
    }
  }

  useEffect(() => {
    if (!email.id) {
      return
    }
    setLoading(true)
    setNextCursor(null)
    fetchMessages(undefined, true)
    void fetchQuota()
    startPolling() 

    return () => {
      stopPolling() 
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id, pollIntervalMs])

  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      setRefreshing(true)
      fetchMessages()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger])

  return (
  <>
    <div className="h-full flex flex-col">
      <div className="flex min-w-0 items-center gap-2 border-b border-primary/20 p-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshing}
          className={cn("h-8 w-8", refreshing && "animate-spin")}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <span className="max-w-28 shrink-0 truncate text-xs text-gray-500 sm:max-w-none">
          {total > 0 ? t("messageCount", { count: total }) : t("noMessages")}
        </span>
        {quota && <div className="ml-auto flex min-w-0 flex-1 justify-end gap-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground [scrollbar-width:none]">
          {(["receive", "send"] as const).map(direction => {
            const state = quota[direction]
            if (!state) return null
            const errorSummary = !state.allowed && state.error
              ? tFormat("labelValue", {
                label: t(`quota.${direction}` as never),
                value: tApi.has(state.error as never)
                  ? tApi(state.error as never)
                  : t(`quota.${direction}` as never),
              })
              : null
            const errorBadge = errorSummary
              ? <span key={direction} title={errorSummary} className="max-w-48 shrink-0 truncate rounded-full border bg-muted/40 px-2 py-0.5">{errorSummary}</span>
              : null
            const applied = state.quota?.applied ?? []
            if (applied.length === 0) return errorBadge
            const finiteRolling = applied.flatMap(item => item.rolling.remaining === null ? [] : [item.rolling.remaining])
            const finiteLifetime = applied.flatMap(item => item.lifetimeRemaining === null ? [] : [item.lifetimeRemaining])
            const parts = [
              finiteRolling.length === 0
                ? null
                : t("quota.window", { count: Math.min(...finiteRolling) }),
              finiteLifetime.length === 0
                ? null
                : t("quota.lifetime", { count: Math.min(...finiteLifetime) }),
            ].filter((value): value is string => value !== null)
            if (parts.length === 0) return errorBadge
            const summary = tFormat("labelValue", {
              label: t(`quota.${direction}` as never),
              value: format.list(parts, { type: "unit" }),
            })
            return <span key={direction} title={summary} className="max-w-48 shrink-0 truncate rounded-full border bg-muted/40 px-2 py-0.5">{summary}</span>
          })}
        </div>}
      </div>

      <div className="flex-1 overflow-auto" onScroll={handleScroll}>
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-500">{t("loading")}</div>
        ) : messages.length > 0 ? (
          <div className="divide-y divide-primary/10">
            {messages.map(message => (
              <div
                key={message.id}
                onClick={() => onMessageSelect(message.id, messageType)}
                className={cn(
                  "p-3 hover:bg-primary/5 cursor-pointer group",
                  selectedMessageId === message.id && "bg-primary/10"
                )}
              >
                <div className="flex items-start gap-3">
                  <Mail className="w-4 h-4 text-primary/60 mt-1" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{message.subject || t("noSubject")}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                      <span className="truncate">
                        {message.from_address || message.to_address || ''}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {format.dateTime(new Date(message.received_at || message.sent_at || 0))}
                      </span>
                    </div>
                  </div>
                  {(canShare || canDelete) && <div className="flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100" onClick={(e) => e.stopPropagation()}>
                    {canShare && <ShareMessageDialog
                      emailId={email.id}
                      messageId={message.id}
                      messageSubject={message.subject || t("noSubject")}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                        >
                          <Share2 className="h-4 w-4" />
                        </Button>
                      }
                    />}
                    {canDelete && <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMessageToDelete(message)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>}
                  </div>}
                </div>
              </div>
            ))}
            {loadingMore && (
              <div className="text-center text-sm text-gray-500 py-2">
                {t("loadingMore")}
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-sm text-gray-500">
            {t("noMessages")}
          </div>
        )}
      </div>
    </div>
    <AlertDialog open={!!messageToDelete} onOpenChange={() => setMessageToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tList("deleteConfirm")}</AlertDialogTitle>
          <AlertDialogDescription>
            {tList("deleteDescription", { email: messageToDelete?.subject || t("noSubject") })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => messageToDelete && handleDelete(messageToDelete)}
          >
            {tCommon("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  )
}
