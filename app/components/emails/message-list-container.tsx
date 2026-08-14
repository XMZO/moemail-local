"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Send, Inbox } from "lucide-react"
import { Tabs, SlidingTabsList, SlidingTabsTrigger, TabsContent } from "@/components/ui/tabs"
import { MessageList } from "./message-list"

interface MessageListContainerProps {
  email: {
    id: string
    address: string
  }
  onMessageSelect: (messageId: string | null, messageType?: 'received' | 'sent') => void
  selectedMessageId?: string | null
  refreshTrigger?: number
}

export function MessageListContainer({ email, onMessageSelect, selectedMessageId, refreshTrigger }: MessageListContainerProps) {
  const t = useTranslations("emails.messages")
  const [activeTab, setActiveTab] = useState<'received' | 'sent'>('received')

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId as 'received' | 'sent')
    onMessageSelect(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex h-full min-h-0 flex-col">
          <div className="p-2 border-b border-primary/20">
            <SlidingTabsList>
              <SlidingTabsTrigger value="received">
                <Inbox className="h-4 w-4" />
                {t("received")}
              </SlidingTabsTrigger>
              <SlidingTabsTrigger value="sent">
                <Send className="h-4 w-4" />
                {t("sent")}
              </SlidingTabsTrigger>
            </SlidingTabsList>
          </div>
          
          <TabsContent value="received" className="m-0 min-h-0 flex-1 overflow-hidden">
            <MessageList
              email={email}
              messageType="received"
              onMessageSelect={onMessageSelect}
              selectedMessageId={selectedMessageId}
            />
          </TabsContent>
          
          <TabsContent value="sent" className="m-0 min-h-0 flex-1 overflow-hidden">
            <MessageList
              email={email}
              messageType="sent"
              onMessageSelect={onMessageSelect}
              selectedMessageId={selectedMessageId}
              refreshTrigger={refreshTrigger}
            />
          </TabsContent>
      </Tabs>
    </div>
  )
}
