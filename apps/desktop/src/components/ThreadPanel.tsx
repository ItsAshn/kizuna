import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { Hash, ArrowLeft, MessageSquare, Inbox, Send, Trash2, X } from 'lucide-react'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  fetchThreadMessages,
  sendThreadMessage,
  fetchThreads,
  deleteThread,
  editMessage,
  deleteMessage,
} from '@kizuna/shared'
import { showErrorToast } from '../utils/showNotification'
import MessageBubble from './MessageBubble'
import IconButton from './ui/IconButton'
import './ThreadPanel.css'

interface Props {
  channelId: string
  socketRef: MutableRefObject<Socket | null>
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

function ThreadListView({
  channelId,
  onSelect,
}: {
  channelId: string
  onSelect: (id: string) => void
}) {
  const session = useServerStore((s) => s.activeSession)
  const threads = useChatStore((s) => s.threads[channelId] || [])
  const setThreads = useChatStore((s) => s.setThreads)
  const setThreadPanelVisible = useChatStore((s) => s.setThreadPanelVisible)
  const reconnectNonce = useSettingsStore((s) => s.socketReconnectNonce)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    fetchThreads(session.url, channelId)
      .then((ts) => {
        if (!cancelled) setThreads(channelId, ts)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [channelId, session, setThreads, reconnectNonce])

  return (
    <div className="thread-panel__list">
      <div className="thread-panel__header">
        <div className="thread-panel__header-left">
          <MessageSquare className="icon-xs thread-panel__header-icon" />
          <span className="thread-panel__header-title">Threads</span>
        </div>
        <IconButton
          size="sm"
          variant="danger"
          onClick={() => setThreadPanelVisible(false)}
          label="Close thread panel"
          icon={<X size={14} />}
        />
      </div>

      {threads.length === 0 ? (
        <div className="thread-panel__empty">
          <Inbox className="icon-lg thread-panel__empty-icon" />
          <p className="thread-panel__empty-title">No threads yet</p>
          <p className="thread-panel__empty-subtitle">
            Right-click a message and select "Create Thread" to start one.
          </p>
        </div>
      ) : (
        <div className="thread-panel__thread-items">
          {threads.map((t) => (
            <button key={t.id} className="thread-panel__thread-item" onClick={() => onSelect(t.id)}>
              <Hash className="icon-xs thread-panel__thread-icon" />
              <div className="thread-panel__thread-body">
                <span className="thread-panel__thread-name">{t.name}</span>
                <span className="thread-panel__thread-meta">
                  {t.message_count} {t.message_count === 1 ? 'message' : 'messages'}
                  {' · '}
                  {formatRelativeTime(t.last_message_at)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ThreadDetailView({
  channelId,
  socketRef,
}: {
  channelId: string
  socketRef: MutableRefObject<Socket | null>
}) {
  const session = useServerStore((s) => s.activeSession)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const threads = useChatStore((s) => s.threads[channelId] || [])
  const threadMessages = useChatStore(
    (s) => (activeThreadId ? s.threadMessages[activeThreadId] : undefined) ?? [],
  )
  const setActiveThreadId = useChatStore((s) => s.setActiveThreadId)
  const setThreadPanelVisible = useChatStore((s) => s.setThreadPanelVisible)
  const setThreadMessages = useChatStore((s) => s.setThreadMessages)
  const addThreadMessage = useChatStore((s) => s.addThreadMessage)
  const removeThread = useChatStore((s) => s.removeThread)
  const members = useChatStore((s) => s.members)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const reconnectNonce = useSettingsStore((s) => s.socketReconnectNonce)

  const activeThread = threads.find((t) => t.id === activeThreadId)

  /* Replies are broadcast to the thread's own socket room, so the panel has to
   * be in it to see anyone else's messages live. Re-runs after a reconnect,
   * which starts a fresh socket with no rooms, and refetches what was missed. */
  useEffect(() => {
    if (!activeThreadId || !session) return
    let cancelled = false
    const socket = socketRef.current
    socket?.emit('thread:join', activeThreadId)
    setLoading(true)
    fetchThreadMessages(session.url, channelId, activeThreadId)
      .then(({ messages }) => {
        if (!cancelled) setThreadMessages(activeThreadId, messages)
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      socket?.emit('thread:leave', activeThreadId)
    }
  }, [activeThreadId, session, channelId, setThreadMessages, socketRef, reconnectNonce])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [threadMessages])

  const handleSend = useCallback(async () => {
    if (!session || !activeThreadId || !input.trim()) return
    // Enter repeats faster than a request round-trips; without a lock the
    // same reply was posted several times.
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    const content = input.trim()
    try {
      const msg = await sendThreadMessage(session.url, channelId, activeThreadId, content)
      addThreadMessage(activeThreadId, msg)
      setInput((current) => (current.trim() === content ? '' : current))
    } catch (err) {
      console.error('Failed to send thread message:', err)
      showErrorToast('send the reply')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [session, activeThreadId, channelId, input, addThreadMessage])

  const handleEditReply = useCallback(
    async (messageId: string, content: string) => {
      if (!session) return
      try {
        const updated = await editMessage(session.url, messageId, content)
        useChatStore.getState().updateThreadMessage(messageId, updated)
      } catch (err) {
        console.error('Failed to edit thread message:', err)
        showErrorToast('edit the reply')
      }
    },
    [session],
  )

  const handleDeleteReply = useCallback(
    async (messageId: string) => {
      if (!session) return
      try {
        await deleteMessage(session.url, messageId)
        useChatStore.getState().removeThreadMessage(messageId)
      } catch (err) {
        console.error('Failed to delete thread message:', err)
        showErrorToast('delete the reply')
      }
    },
    [session],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleDelete = useCallback(async () => {
    if (!session || !activeThreadId || deleting) return
    setDeleting(true)
    try {
      await deleteThread(session.url, channelId, activeThreadId)
      removeThread(channelId, activeThreadId)
      setActiveThreadId(null)
    } catch (err) {
      console.error('Failed to delete thread:', err)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }, [session, activeThreadId, channelId, deleting, removeThread, setActiveThreadId])

  const canDelete =
    activeThread &&
    (activeThread.creator_id === session?.user.id ||
      members.some(
        (m) =>
          m.id === session?.user.id &&
          m.custom_roles?.some((r) => r.is_admin || r.permissions?.delete_messages),
      ))

  return (
    <div className="thread-panel__detail">
      <div className="thread-panel__header">
        <div className="thread-panel__header-left">
          <IconButton
            size="sm"
            onClick={() => setActiveThreadId(null)}
            label="Back to threads"
            icon={<ArrowLeft className="icon-sm" />}
          />
          <Hash className="icon-xs thread-panel__header-icon" />
          <span className="thread-panel__header-title">{activeThread?.name || 'Thread'}</span>
        </div>
        <IconButton
          size="sm"
          variant="danger"
          onClick={() => setThreadPanelVisible(false)}
          label="Close thread"
          icon={<X size={14} />}
        />
      </div>

      {activeThread && (
        <div className="thread-panel__meta">
          <span className="thread-panel__meta-count">
            {activeThread.message_count} {activeThread.message_count === 1 ? 'message' : 'messages'}
          </span>
          {canDelete && (
            <button
              className="thread-panel__meta-delete"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete thread"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}

      {confirmDelete && (
        <div className="thread-panel__delete-confirm">
          <p className="thread-panel__delete-confirm-text">
            Delete this thread and all its messages? This action cannot be undone.
          </p>
          <div className="thread-panel__delete-confirm-actions">
            <button
              className="thread-panel__delete-confirm-btn"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              className="thread-panel__delete-confirm-btn thread-panel__delete-confirm-btn--danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : 'Delete Thread'}
            </button>
          </div>
        </div>
      )}

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
            currentUsername={session?.user.username}
            canDelete={msg.user_id === session?.user.id}
            onDelete={handleDeleteReply}
            canEdit={msg.user_id === session?.user.id}
            onEdit={handleEditReply}
            serverUrl={session?.url}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="thread-panel__composer">
        <textarea
          className="thread-panel__input"
          placeholder={`Message thread: ${activeThread?.name || ''}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={4000}
          rows={1}
        />
        <button
          className="thread-panel__send"
          onClick={handleSend}
          disabled={!input.trim() || sending}
          aria-label="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  )
}

export default function ThreadPanel({ channelId, socketRef }: Props) {
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const threadPanelVisible = useChatStore((s) => s.threadPanelVisible)
  const setActiveThreadId = useChatStore((s) => s.setActiveThreadId)

  if (!threadPanelVisible) {
    return null
  }

  return (
    <div className="thread-panel">
      {activeThreadId ? (
        <ThreadDetailView channelId={channelId} socketRef={socketRef} />
      ) : (
        <ThreadListView channelId={channelId} onSelect={setActiveThreadId} />
      )}
    </div>
  )
}
