import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { fetchMessages, fetchDMMessages, sendMessage, sendDMMessage, deleteMessage, editMessage, deleteDMMessage, editDMMessage, uploadAttachment, fetchChannelPermissions } from '@kizuna/shared'
import { encryptDM, decryptDM, isEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import { Lock, Paperclip, Send, Film } from 'lucide-react'
import type { Message, Member } from '@kizuna/shared'
import MessageBubble from './MessageBubble'
import GifPicker from './GifPicker'
import '../styles/chat-area.css'

interface ChatAreaProps {
  socketRef: MutableRefObject<Socket | null>
}

function getAtQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor)
  const match = /(?:^|[\s])@([\w.\-]*)$/.exec(before)
  return match ? match[1] : null
}

function hasDeletePermission(members: Member[], currentUserId: string, currentUserRole?: string): boolean {
  if (currentUserRole === 'admin') return true
  const me = members.find(m => m.id === currentUserId)
  if (!me) return false
  return me.custom_roles?.some(r => r.permissions?.delete_messages === true || r.is_admin) ?? false
}

function formatDateSeparator(date: Date): string {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === now.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'

  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

export default function ChatArea({ socketRef }: ChatAreaProps) {
  const session = useServerStore((s) => s.activeSession)
  const { channels, dmChannels, messages, members, activeChannelId, activeDMChannelId, addMessage, typingUsers } = useChatStore()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null)
  const [pendingAttachmentId, setPendingAttachmentId] = useState<string | null>(null)
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [gifPickerOpen, setGifPickerOpen] = useState(false)
  const [atIndex, setAtIndex] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [channelPerms, setChannelPerms] = useState<{ can_write: boolean; locked: boolean; write_role_name: string | null } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const tryDecryptDM = useCallback((msg: Message): Message => {
    if (!msg.encrypted) return msg
    const parsed = isEncryptedContent(msg.content)
    if (!parsed) return msg
    const secKey = getSecretKey()
    if (!secKey) return { ...msg, content: '[Encrypted - no key available]' }
    const activeDM = dmChannels.find((d) => d.id === msg.channel_id)
    const otherPubKey = activeDM?.other_public_key
    if (!otherPubKey) return { ...msg, content: '[Encrypted - missing recipient key]' }
    try {
      const decrypted = decryptDM(parsed, otherPubKey, secKey)
      return { ...msg, content: decrypted }
    } catch {
      return { ...msg, content: '[Encrypted - unable to decrypt]' }
    }
  }, [dmChannels])

  const activeChannel = channels.find((c) => c.id === activeChannelId)
  const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
  const channelMessages = messages[activeChannelId || ''] || []
  const dmMessages = messages[activeDMChannelId || ''] || []

  const canDeleteAny = activeChannelId && session
    ? hasDeletePermission(members, session.user.id, session.user.role)
    : false

  const specialTargets = ['everyone', 'here']
  const allSuggestions = [...specialTargets, ...members.map(m => m.username)]
  const suggestions = atQuery !== null
    ? allSuggestions.filter(u => u.toLowerCase().startsWith(atQuery.toLowerCase()))
    : []

  useEffect(() => { setSelectedIndex(0) }, [suggestions.length, atQuery])
  useEffect(() => {
    suggestionRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    if (activeChannelId) {
      setLoading(true)
      setChannelPerms(null)
      fetchMessages(session!.url, session!.token, activeChannelId)
        .then((msgs) => useChatStore.getState().setMessages(activeChannelId, msgs))
        .finally(() => setLoading(false))

      fetchChannelPermissions(session!.url, session!.token, activeChannelId)
        .then(setChannelPerms)
        .catch(() => setChannelPerms(null))

      const store = useChatStore.getState()
      store.setUnreadCounts({ ...store.unreadCounts, [activeChannelId]: 0 })
      store.setMentionCounts({ ...store.mentionCounts, [activeChannelId]: 0 })

      socketRef.current?.emit('channel:join', activeChannelId)
      socketRef.current?.emit('mentions:read', { channelId: activeChannelId })
      socketRef.current?.emit('channel:read', { channelId: activeChannelId })

      return () => { socketRef.current?.emit('channel:leave', activeChannelId) }
    }
  }, [activeChannelId])

  useEffect(() => {
    if (activeDMChannelId) {
      setLoading(true)
      setChannelPerms(null)
      fetchDMMessages(session!.url, session!.token, activeDMChannelId)
        .then((msgs) => {
          const decrypted = msgs.map((m) => tryDecryptDM(m))
          useChatStore.getState().setMessages(activeDMChannelId, decrypted)
        })
        .finally(() => setLoading(false))

      const store = useChatStore.getState()
      store.setUnreadCounts({ ...store.unreadCounts, [activeDMChannelId]: 0 })
      store.setMentionCounts({ ...store.mentionCounts, [activeDMChannelId]: 0 })

      socketRef.current?.emit('dm:read', { channelId: activeDMChannelId })

      return () => { socketRef.current?.emit('channel:leave', activeDMChannelId) }
    }
  }, [activeDMChannelId, tryDecryptDM])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [channelMessages, dmMessages])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    if (sendError) setSendError(null)

    const cursor = e.target.selectionStart ?? val.length
    const query = getAtQuery(val, cursor)
    setAtQuery(query)
    if (query !== null) {
      const before = val.slice(0, cursor)
      setAtIndex(before.lastIndexOf('@'))
    }

    const el = inputRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    }

    const channelId = activeChannelId || activeDMChannelId
    if (channelId && session) {
      if (typingTimeout.current) clearTimeout(typingTimeout.current)
      socketRef.current?.emit('typing:start', { channelId })
      typingTimeout.current = setTimeout(() => {
        socketRef.current?.emit('typing:stop', { channelId })
      }, 3000)
    }
  }, [sendError, activeChannelId, activeDMChannelId, session])

  const insertMention = (username: string) => {
    const before = input.slice(0, atIndex)
    const after = input.slice(atIndex + 1 + (atQuery?.length ?? 0))
    const newVal = `${before}@${username} ${after}`
    setInput(newVal)
    setAtQuery(null)
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + username.length + 2
        inputRef.current.setSelectionRange(pos, pos)
        inputRef.current.focus()
      }
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => (i + 1) % suggestions.slice(0, 8).length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => (i - 1 + suggestions.slice(0, 8).length) % suggestions.slice(0, 8).length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertMention(suggestions[selectedIndex] ?? suggestions[0]); return }
      if (e.key === 'Escape') { e.preventDefault(); setAtQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleSend = async () => {
    if ((!input.trim() && !pendingFile) || !session) return

    if (pendingFile) { await handleUpload(); return }

    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return

    socketRef.current?.emit('typing:stop', { channelId })

    try {
      let message: Message
      if (activeChannelId) {
        const attIds = pendingAttachmentId ? [pendingAttachmentId] : undefined
        message = await sendMessage(session.url, session.token, activeChannelId, input.trim(), attIds)
        setPendingAttachmentId(null)
      } else if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
        const otherPubKey = activeDM?.other_public_key
        const secKey = getSecretKey()
        let content: string
        let encrypted = false
        if (otherPubKey && secKey) {
          const enc = encryptDM(input.trim(), otherPubKey, secKey)
          content = JSON.stringify(enc)
          encrypted = true
        } else {
          content = input.trim()
        }
        message = await sendDMMessage(session.url, session.token, activeDMChannelId, content, encrypted)
        if (encrypted) {
          message = { ...message, content: input.trim() }
        }
      } else {
        return
      }
      addMessage(message.channel_id || channelId, message)
      setInput('')
      setSendError(null)
      if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.focus() }
    } catch (err: any) {
      const status = err?.response?.status
      const serverMsg = err?.response?.data?.error
      if (status === 403) setSendError(serverMsg || 'You do not have permission to send messages')
      else setSendError('Failed to send message. Try again.')
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPendingFile(file)
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
    const isImage = file.type.startsWith('image/')
    setPendingPreviewUrl(isImage ? URL.createObjectURL(file) : null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleUpload = async () => {
    if (!pendingFile || !session) return

    if (!activeChannelId) {
      setSendError('File uploads are only available in server channels, not DMs.')
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
      setPendingFile(null)
      setPendingPreviewUrl(null)
      return
    }

    setUploading(true)
    setUploadProgress(0)
    try {
      const result = await uploadAttachment(session.url, session.token, activeChannelId, pendingFile, (pct) => setUploadProgress(pct))
      setPendingAttachmentId(result.id)
      const attachmentText = `![${result.filename}](${result.url})`
      const text = input.trim()
      const attIds = [result.id]
      const message = await sendMessage(
        session.url, session.token, activeChannelId,
        text ? text + '\n' + attachmentText : attachmentText,
        attIds,
      )
      addMessage(message.channel_id, message)
      setInput('')
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
      setPendingFile(null)
      setPendingPreviewUrl(null)
      setPendingAttachmentId(null)
      setSendError(null)
      if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.focus() }
    } catch (err: any) {
      setSendError(err?.response?.data?.error || err?.message || 'Failed to upload file')
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
      setPendingPreviewUrl(null)
      setPendingAttachmentId(null)
    }
    setUploading(false)
  }

  const handleDeleteMessage = async (messageId: string) => {
    if (!session) return
    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return
    try {
      if (activeDMChannelId) {
        await deleteDMMessage(session.url, session.token, messageId)
      } else {
        await deleteMessage(session.url, session.token, messageId)
      }
    } catch { /* ignore */ }
  }

  const handleEditMessage = async (messageId: string, content: string) => {
    if (!session) return
    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return
    try {
      if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
        const otherPubKey = activeDM?.other_public_key
        const secKey = getSecretKey()
        let sendContent = content
        let encrypted = false
        if (otherPubKey && secKey) {
          const enc = encryptDM(content, otherPubKey, secKey)
          sendContent = JSON.stringify(enc)
          encrypted = true
        }
        await editDMMessage(session.url, session.token, messageId, sendContent, encrypted)
      } else {
        await editMessage(session.url, session.token, messageId, content)
      }
    } catch { /* ignore */ }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const headerTitle = activeChannel?.name || activeDM?.other_display_name || 'Kizuna'
  const displayMessages = activeDMChannelId ? dmMessages : channelMessages
  const channelId = activeChannelId || activeDMChannelId || ''
  const typingList = typingUsers[channelId]?.filter(u => u !== session?.user.username) || []
  const typingText = typingList.length === 1
    ? `${typingList[0]} is typing...`
    : typingList.length > 1
      ? `${typingList.length} people are typing...`
      : ''
  const dmHasKey = activeDMChannelId ? !!(activeDM?.other_public_key && getSecretKey()) : false
  const inputMaxLen = activeDMChannelId ? 2700 : 4000
  const cantWrite = channelPerms?.locked && !channelPerms?.can_write

  const renderMessagesWithGroups = () => {
    let lastDate = ''
    let lastUserId = ''
    const elements: React.ReactNode[] = []

    displayMessages.forEach((msg, i) => {
      const msgDate = new Date(msg.created_at).toDateString()
      if (msgDate !== lastDate) {
        lastDate = msgDate
        elements.push(
          <div key={`date-${msg.id}`} className="msg-bubble__date-separator">
            <span className="msg-bubble__date-label">{formatDateSeparator(new Date(msg.created_at))}</span>
          </div>
        )
      }

      const isOwn = msg.user_id === session?.user.id
      const isGrouped = msg.user_id === lastUserId && !isOwn
      lastUserId = msg.user_id

      const showProfile = !!channelPerms?.locked
      const messageCanDelete = isOwn || canDeleteAny

      elements.push(
        <MessageBubble
          key={msg.id}
          message={msg}
          isOwn={isOwn}
          isGrouped={isGrouped}
          members={members}
          currentUsername={session?.user.username}
          canDelete={messageCanDelete}
          onDelete={handleDeleteMessage}
          canEdit={isOwn}
          onEdit={handleEditMessage}
          serverUrl={session?.url}
        />
      )
    })

    return elements
  }

  return (
    <div className="chat-area">
      <div className="chat-area__header">
        <span className="chat-area__header-prefix">{activeDMChannelId ? '@' : '#'}</span>
        <h2 className="chat-area__header-title">{headerTitle}</h2>
        {activeDMChannelId && dmHasKey && (
          <span className="chat-area__encrypted-badge" title="End-to-end encrypted">🔒</span>
        )}
        {activeDMChannelId && !dmHasKey && activeDM?.other_public_key !== undefined && (
          <span className="chat-area__encrypted-badge chat-area__encrypted-badge--warn" title="Not encrypted - keys unavailable">{activeDM?.other_public_key === null ? '⚠️' : '⚠️'}</span>
        )}
        {activeChannel?.topic && (
          <span className="chat-area__header-topic">{activeChannel.topic}</span>
        )}
        {channelPerms?.locked && (
          <span className={`chat-area__locked-badge ${channelPerms.can_write ? 'chat-area__locked-badge--can-write' : ''}`}>
            <Lock size={12} className="chat-area__locked-badge-icon" />
            {channelPerms.can_write ? 'Locked' : `Locked to ${channelPerms.write_role_name || 'a role'}`}
          </span>
        )}
      </div>

      <div className="chat-area__messages">
        {loading && <p className="chat-area__loading">Loading messages...</p>}
        {!loading && displayMessages.length === 0 && (
          <p className="chat-area__loading">No messages yet. Be the first to send one!</p>
        )}
        {renderMessagesWithGroups()}
        {typingText && <div className="chat-area__typing">{typingText}</div>}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-area__input-bar">
        {suggestions.length > 0 && (
          <div className="chat-area__mention-suggestions">
            {suggestions.slice(0, 8).map((u, i) => (
              <button
                key={u}
                ref={(el) => { suggestionRefs.current[i] = el }}
                onMouseDown={(e) => { e.preventDefault(); insertMention(u) }}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`chat-area__mention-suggestion ${i === selectedIndex ? 'chat-area__mention-suggestion--selected' : ''}`}
              >
                <span className="chat-area__mention-prefix">@</span>
                {u}
                {(u === 'everyone' || u === 'here') && <span className="chat-area__mention-group-tag">group</span>}
              </button>
            ))}
          </div>
        )}

        {pendingFile && (
          <div className="chat-area__upload-preview">
            {pendingPreviewUrl && (
              <img src={pendingPreviewUrl} alt="" className="chat-area__upload-thumbnail" />
            )}
            <div className="chat-area__upload-info">
              <p className="chat-area__upload-name">{pendingFile.name}</p>
              <p className="chat-area__upload-size">{formatFileSize(pendingFile.size)}</p>
            </div>
            {uploading ? (
              <span className="chat-area__upload-progress">{uploadProgress > 0 && uploadProgress < 100 ? `${uploadProgress}%` : 'uploading...'}</span>
            ) : (
              <button className="chat-area__upload-cancel" onClick={() => { if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl); setPendingFile(null); setPendingPreviewUrl(null); setPendingAttachmentId(null) }}>cancel</button>
            )}
          </div>
        )}

        <div className="chat-area__input-row">
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
            accept="image/*,video/*,audio/*,.pdf,.txt,.json"
          />
          <button className="chat-area__attach-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading || !!activeDMChannelId} title={activeDMChannelId ? 'File upload not available in DMs' : 'Attach file'}>
            <Paperclip size={16} />
          </button>
          <button className="chat-area__gif-btn" onClick={() => setGifPickerOpen(true)} title="GIFs & Stickers">
            <Film size={16} />
          </button>
          <textarea
            ref={inputRef}
            className={`chat-area__input ${cantWrite ? 'chat-area__input--locked' : ''}`}
            rows={1}
            style={{ resize: 'none' }}
            placeholder={cantWrite ? `Channel locked — you cannot send messages` : `Message ${activeDMChannelId ? `@${activeDM?.other_display_name}` : `#${activeChannel?.name}`}`}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            maxLength={inputMaxLen}
            disabled={cantWrite}
          />
          <button className="chat-area__send-btn" onClick={handleSend} disabled={((!input.trim() && !pendingFile) || uploading || cantWrite)}>
            <Send size={16} />
          </button>
        </div>
        {sendError ? (
          <p className="chat-area__input-hint chat-area__input-hint--error">{sendError}</p>
        ) : (
          <p className="chat-area__input-hint">enter to send · shift+enter for new line · @ to mention · paperclip for files</p>
        )}
        {gifPickerOpen && session && (
          <GifPicker
            serverUrl={session.url}
            token={session.token}
            onSelect={(url, displayName) => {
              setInput(prev => prev + `![${displayName}](${url})`)
              setGifPickerOpen(false)
              inputRef.current?.focus()
            }}
            onClose={() => setGifPickerOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
