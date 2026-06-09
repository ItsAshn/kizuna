import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { fetchMessages, fetchDMMessages, sendMessage, sendDMMessage, deleteMessage, uploadAttachment, fetchChannelPermissions } from '@kizuna/shared'
import { encryptDM, decryptDM, isEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import { Lock } from 'lucide-react'
import type { Message, Member } from '@kizuna/shared'
import '../styles/chat-area.css'

interface ChatAreaProps {
  socketRef: MutableRefObject<Socket | null>
}

function getAtQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor)
  const match = /(?:^|[\s])@([\w.\-]*)$/.exec(before)
  return match ? match[1] : null
}

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(url)
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm)$/i.test(url)
}

function isAudioUrl(url: string): boolean {
  return /\.(mp3|ogg|wav)$/i.test(url)
}

function parseAttachments(content: string): { text: string; attachments: { url: string; filename: string }[] } {
  const attachments: { url: string; filename: string }[] = []
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  let match
  let text = content

  while ((match = markdownImageRegex.exec(content)) !== null) {
    const filename = match[1] || 'file'
    const url = match[2]
    if (url.startsWith('/uploads/') || url.startsWith('http')) {
      attachments.push({ filename, url })
      text = text.replace(match[0], '')
    }
  }

  const urlRegex = /(https?:\/\/[^\s]+)/g
  while ((match = urlRegex.exec(content)) !== null) {
    const url = match[1]
    if (isImageUrl(url) || isVideoUrl(url) || isAudioUrl(url) || url.endsWith('.pdf')) {
      if (!attachments.some((a) => a.url === url)) {
        attachments.push({ filename: url.split('/').pop() || 'file', url })
      }
    }
  }

  return { text: text.trim(), attachments }
}

function renderMentions(content: string, members: Member[], currentUsername?: string) {
  const parts = content.split(/(@(?:everyone|here|[\w.\-]+))/g)
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      const tag = part.slice(1).toLowerCase()
      const isMe = currentUsername && tag === currentUsername.toLowerCase()
      const isGroup = tag === 'everyone' || tag === 'here'
      const cls = isMe ? 'chat-area__mention--self' : isGroup ? 'chat-area__mention--group' : 'chat-area__mention--user'
      return <span key={i} className={cls}>{part}</span>
    }
    return <span key={i}>{part}</span>
  })
}

function AttachmentPreview({ url, filename }: { url: string; filename: string }) {
  const [expanded, setExpanded] = useState(false)
  const [loadError, setLoadError] = useState(false)

  if (loadError) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="chat-area__attachment-link">
        <span className="chat-area__attachment-filename">{filename}</span>
      </a>
    )
  }

  if (isImageUrl(url)) {
    return (
      <div className="chat-area__attachment-image-wrap" onClick={() => setExpanded(!expanded)}>
        <img
          src={url}
          alt={filename}
          className={`chat-area__attachment-image ${expanded ? 'chat-area__attachment-image--expanded' : ''}`}
          onError={() => setLoadError(true)}
        />
        {!expanded && <div className="chat-area__attachment-expand-hint">expand</div>}
      </div>
    )
  }

  if (isVideoUrl(url)) {
    return <video src={url} controls className="chat-area__attachment-video" onError={() => setLoadError(true)} />
  }

  if (isAudioUrl(url)) {
    return <audio src={url} controls className="chat-area__attachment-audio" onError={() => setLoadError(true)} />
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="chat-area__attachment-link">
      <span className="chat-area__attachment-filename">{filename}</span>
    </a>
  )
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
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
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
    const senderIsMe = msg.user_id === session?.user.id
    let theirPubKey: string
    if (senderIsMe) {
      theirPubKey = otherPubKey
    } else {
      theirPubKey = otherPubKey
    }
    try {
      const decrypted = decryptDM(parsed, theirPubKey, secKey)
      return { ...msg, content: decrypted }
    } catch {
      return { ...msg, content: '[Encrypted - unable to decrypt]' }
    }
  }, [dmChannels, session?.user.id])

  const activeChannel = channels.find((c) => c.id === activeChannelId)
  const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
  const channelMessages = messages[activeChannelId || ''] || []
  const dmMessages = messages[activeDMChannelId || ''] || []

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
    if (!input.trim() || !session) return

    if (pendingFile) { await handleUpload(); return }

    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return

    socketRef.current?.emit('typing:stop', { channelId })

    try {
      let message: Message
      if (activeChannelId) {
        message = await sendMessage(session.url, session.token, activeChannelId, input.trim())
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
        message = tryDecryptDM(message)
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
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleUpload = async () => {
    if (!pendingFile || !session || !activeChannelId) return
    setUploading(true)
    setUploadProgress(0)
    try {
      const result = await uploadAttachment(session.url, session.token, activeChannelId, pendingFile, (pct) => setUploadProgress(pct))
      const attachmentText = `![${result.filename}](${result.url})`
      const text = input.trim()
      const message = await sendMessage(
        session.url, session.token, activeChannelId,
        text ? text + '\n' + attachmentText : attachmentText,
      )
      addMessage(message.channel_id, message)
      setInput('')
      setPendingFile(null)
      setSendError(null)
      if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.focus() }
    } catch (err: any) {
      setSendError(err?.response?.data?.error || 'Failed to upload file')
    }
    setUploading(false)
  }

  const handleDeleteMessage = async (messageId: string) => {
    if (!session) return
    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return
    try {
      await deleteMessage(session.url, session.token, messageId)
      useChatStore.getState().removeMessage(channelId, messageId)
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
        {displayMessages.map((msg) => {
          const isOwn = msg.user_id === session?.user.id
          const displayName = msg.display_name || msg.username || 'Unknown'
          const { text, attachments } = parseAttachments(msg.content)
          const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          return (
            <div key={msg.id} className={`chat-area__message-row ${isOwn ? 'chat-area__message-row--own' : ''}`}>
              {!isOwn && (
                <div className="chat-area__message-avatar">
                  {msg.avatar ? (
                    <img src={msg.avatar} alt="" className="chat-area__message-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  ) : displayName[0]?.toUpperCase()}
                </div>
              )}
              <div style={isOwn ? { alignItems: 'flex-end' } : {}} className={`chat-area__message-bubble ${isOwn ? 'chat-area__message-bubble--own' : 'chat-area__message-bubble--other'}`}>
                {!isOwn && <p className="chat-area__message-author">{displayName}</p>}
                {text && <p className="chat-area__message-text">{renderMentions(text, members, session?.user.username)}</p>}
                {attachments.length > 0 && attachments.map((att, i) => (
                  <AttachmentPreview key={i} url={att.url} filename={att.filename} />
                ))}
                <div className="chat-area__message-meta">
                  <span className="chat-area__message-time">{time}</span>
                  {msg.edited_at && <span className="chat-area__message-edited">(edited)</span>}
                  {isOwn && confirmDeleteId === msg.id ? (
                    <span className="chat-area__delete-confirm">
                      <button className="chat-area__delete-confirm-btn chat-area__delete-confirm-btn--yes" onClick={() => { handleDeleteMessage(msg.id); setConfirmDeleteId(null) }}>confirm</button>
                      <button className="chat-area__delete-confirm-btn chat-area__delete-confirm-btn--no" onClick={() => setConfirmDeleteId(null)}>cancel</button>
                    </span>
                  ) : isOwn ? (
                    <button className="chat-area__message-delete" onClick={() => setConfirmDeleteId(msg.id)}>del</button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
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
            <div className="chat-area__upload-info">
              <p className="chat-area__upload-name">{pendingFile.name}</p>
              <p className="chat-area__upload-size">{formatFileSize(pendingFile.size)}</p>
            </div>
            <button className="chat-area__upload-cancel" onClick={() => setPendingFile(null)} disabled={uploading}>cancel</button>
            <button className="btn-primary" onClick={handleUpload} disabled={uploading} style={{ fontSize: '12px', padding: '4px 12px' }}>
              {uploadProgress > 0 && uploadProgress < 100 ? `${uploadProgress}%` : uploading ? 'uploading...' : 'upload'}
            </button>
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
          <button className="chat-area__attach-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading} title="attach file">+</button>
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
          <button className="chat-area__send-btn" onClick={handleSend} disabled={!input.trim() && !pendingFile || cantWrite}>
            Send
          </button>
        </div>
        {sendError ? (
          <p className="chat-area__input-hint chat-area__input-hint--error">{sendError}</p>
        ) : (
          <p className="chat-area__input-hint">enter to send · shift+enter for new line · @ to mention · + for files</p>
        )}
      </div>
    </div>
  )
}
