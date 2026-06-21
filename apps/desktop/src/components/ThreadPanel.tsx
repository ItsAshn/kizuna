import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Hash, Send } from 'lucide-react'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import { fetchThreadMessages, sendThreadMessage, fetchThreads } from '@kizuna/shared'
import type { Message } from '@kizuna/shared'
import MessageBubble from './MessageBubble'
import './ThreadPanel.css'

interface Props {
  channelId: string
}

export default function ThreadPanel({ channelId }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const threads = useChatStore((s) => s.threads[channelId] || [])
  const threadMessages = useChatStore((s) => (activeThreadId ? s.threadMessages[activeThreadId] : undefined) ?? [])
  const setActiveThreadId = useChatStore((s) => s.setActiveThreadId)
  const setThreads = useChatStore((s) => s.setThreads)
  const setThreadMessages = useChatStore((s) => s.setThreadMessages)
  const addThreadMessage = useChatStore((s) => s.addThreadMessage)
  const members = useChatStore((s) => s.members)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeThread = threads.find((t) => t.id === activeThreadId)

  useEffect(() => {
    if (!session) return
    fetchThreads(session.url, channelId)
      .then((ts) => setThreads(channelId, ts))
      .catch(console.error)
  }, [channelId, session, setThreads])

  useEffect(() => {
    if (!activeThreadId || !session) return
    setLoading(true)
    fetchThreadMessages(session.url, channelId, activeThreadId)
      .then(({ messages }) => setThreadMessages(activeThreadId, messages))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [activeThreadId, session, channelId, setThreadMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [threadMessages])

  const handleSend = useCallback(async () => {
    if (!session || !activeThreadId || !input.trim()) return
    try {
      const msg = await sendThreadMessage(session.url, channelId, activeThreadId, input.trim())
      addThreadMessage(activeThreadId, msg)
      setInput('')
    } catch (err) { console.error('Failed to send thread message:', err) }
  }, [session, activeThreadId, channelId, input, addThreadMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  if (!activeThreadId) {
    return null
  }

  return (
    <div className="thread-panel">
      <div className="thread-panel__header">
        <div className="thread-panel__header-left">
          <Hash className="icon-xs thread-panel__header-icon" />
          <span className="thread-panel__header-title">{activeThread?.name || 'Thread'}</span>
        </div>
        <button className="thread-panel__close" onClick={() => setActiveThreadId(null)} aria-label="Close thread">
          <X className="icon-sm" />
        </button>
      </div>

      <div className="thread-panel__messages">
        {loading && threadMessages.length === 0 && (
          <div className="thread-panel__loading">Loading...</div>
        )}
        {!loading && threadMessages.length === 0 && (
          <div className="thread-panel__empty-messages">
            <p>No messages yet</p>
          </div>
        )}
        {threadMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isOwn={msg.user_id === session?.user.id}
            isGrouped={false}
            members={members}
            currentUsername={session?.user.username}
            canDelete={msg.user_id === session?.user.id}
            onDelete={() => {}}
            canEdit={msg.user_id === session?.user.id}
            onEdit={() => {}}
            serverUrl={session?.url}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="thread-panel__composer">
        <input
          className="thread-panel__input"
          placeholder={`Message thread: ${activeThread?.name || ''}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={4000}
        />
        <button
          className="thread-panel__send"
          onClick={handleSend}
          disabled={!input.trim()}
          aria-label="Send"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
