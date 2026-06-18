import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { Virtuoso } from 'react-virtuoso'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useCallStore } from '../store/callStore'
import { useMobile } from '../hooks/useMobile'
import { useSwipeBack } from '../hooks/useSwipeBack'
import { useKeyboard } from '../hooks/useKeyboard'
import { fetchMessages, fetchDMMessages, sendMessage, sendDMMessage, deleteMessage, editMessage, deleteDMMessage, editDMMessage, uploadAttachment, fetchChannelPermissions, getUserPublicKey, fetchRoles } from '@kizuna/shared'
import { encryptDM, decryptDM, isEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import { Lock, Paperclip, Send, Sticker, Phone, ChevronLeft } from 'lucide-react'
import type { Message, Member, DMChannelData, CustomRole } from '@kizuna/shared'
import MessageBubble from './MessageBubble'
import GifPicker from './GifPicker'
import Skeleton from './Skeleton'
import Lightbox from './Lightbox'
import SearchBar from './SearchBar'
import '../styles/chat-area.css'

interface ChatAreaProps {
  socketRef: MutableRefObject<Socket | null>
  onStartDMCall?: (dmChannelId: string, otherUserId: string, otherUsername: string) => void
  onEndDMCall?: () => void
  onBackToSidebar?: () => void
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

export default function ChatArea({ socketRef, onStartDMCall, onEndDMCall, onBackToSidebar }: ChatAreaProps) {
  const session = useServerStore((s) => s.activeSession)
  const isMobile = useMobile()
  const channels = useChatStore((s) => s.channels)
  const dmChannels = useChatStore((s) => s.dmChannels)
  const members = useChatStore((s) => s.members)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId)
  const channelMessages = useChatStore((s) => (activeChannelId ? s.messages[activeChannelId] : undefined) ?? [])
  const dmMessages = useChatStore((s) => (activeDMChannelId ? s.messages[activeDMChannelId] : undefined) ?? [])
  const addMessage = useChatStore((s) => s.addMessage)
  const typingUsers = useChatStore((s) => s.typingUsers)
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages)
  const dmCallStatus = useCallStore((s) => s.dmCallStatus)
  const dmCallChannelId = useCallStore((s) => s.dmCallChannelId)
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
  const [replyTo, setReplyTo] = useState<{ messageId: string; username: string; content: string } | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [channelPerms, setChannelPerms] = useState<{ can_write: boolean; locked: boolean; write_role_name: string | null } | null>(null)
  const virtuosoRef = useRef<any>(null)
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [atBottom, setAtBottom] = useState(true)
  const lastCountAtBottom = useRef(0)
  const scrolledChannelRef = useRef<string | null>(null)
  const [lightboxImages, setLightboxImages] = useState<{ url: string; filename: string }[] | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const [showSearch, setShowSearch] = useState(false)
  const [mentionableRoles, setMentionableRoles] = useState<CustomRole[]>([])
  useSwipeBack(chatAreaRef, onBackToSidebar || (() => {}), !!isMobile && !!onBackToSidebar)
  useKeyboard()
  const tryDecryptDM = useCallback((msg: Message): Message => {
    if (!msg.encrypted) return msg
    const parsed = isEncryptedContent(msg.content)
    if (!parsed) return msg
    const secKey = getSecretKey()
    if (!secKey) return { ...msg, content: '[Encrypted - no key available]' }
    const activeDM = dmChannels.find((d) => d.id === msg.channel_id)
    const otherPubKey = activeDM?.other_public_key
    if (!otherPubKey) return { ...msg, content: '[Encrypted - missing sender key]' }
    try {
      const decrypted = decryptDM(parsed, otherPubKey, secKey)
      return { ...msg, content: decrypted }
    } catch {
      return { ...msg, content: '[Encrypted - unable to decrypt]' }
    }
  }, [dmChannels])

  const resolveRecipientPublicKey = useCallback(async (dm: DMChannelData | undefined): Promise<string | null> => {
    if (!dm || !session) return null
    try {
      const freshKey = await getUserPublicKey(session.url, dm.other_user_id)
      if (freshKey) return freshKey
    } catch (err) { console.error('Failed to get user public key, falling back to cached:', err) }
    return dm.other_public_key ?? null
  }, [session])

  const activeChannel = channels.find((c) => c.id === activeChannelId)
  const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)

  const canDeleteAny = activeChannelId && session
    ? hasDeletePermission(members, session.user.id, session.user.role)
    : false
  const canCall = session?.user.permissions?.initiate_dm_calls === true || session?.user.role === 'admin'

  const specialTargets = ['everyone', 'here']
  const allSuggestions = [
    ...specialTargets,
    ...mentionableRoles.map(r => r.name),
    ...members.map(m => m.username),
  ]
  const suggestions = atQuery !== null
    ? allSuggestions.filter(u => u.toLowerCase().startsWith(atQuery.toLowerCase()))
    : []

  useEffect(() => {
    if (session) {
      fetchRoles(session.url).then(roles => {
        setMentionableRoles(roles.filter(r => r.mentionable))
      }).catch((err) => { console.error('Failed to fetch mentionable roles:', err) })
    }
  }, [session])

  useEffect(() => { setSelectedIndex(0) }, [suggestions.length, atQuery])
  useEffect(() => {
    suggestionRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    if (activeChannelId) {
      let cancelled = false
      setLoading(true)
      setChannelPerms(null)
      fetchMessages(session!.url, activeChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return
          useChatStore.getState().setMessages(activeChannelId, msgs)
          useChatStore.getState().setHasMoreMessages(activeChannelId, hasMore)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      fetchChannelPermissions(session!.url, activeChannelId)
        .then((perms) => {
          if (!cancelled) setChannelPerms(perms)
        })
        .catch((err) => {
          console.error('Failed to fetch channel permissions:', err)
          if (!cancelled) setChannelPerms(null)
        })

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeChannelId]: 0 },
      }))

      socketRef.current?.emit('channel:join', activeChannelId)
      socketRef.current?.emit('mentions:read', { channelId: activeChannelId })
      socketRef.current?.emit('channel:read', { channelId: activeChannelId }, (res: { last_read_at?: number }) => {
        if (cancelled) return
        if (res?.last_read_at) {
          useChatStore.getState().setChannelLastReadAt(activeChannelId, res.last_read_at)
        }
      })

      return () => {
        cancelled = true
        socketRef.current?.emit('channel:leave', activeChannelId)
        socketRef.current?.emit('typing:stop', { channelId: activeChannelId })
      }
    }
  }, [activeChannelId])

  useEffect(() => {
    if (activeDMChannelId) {
      let cancelled = false
      setLoading(true)
      setChannelPerms(null)
      fetchDMMessages(session!.url, activeDMChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return
          const decrypted = msgs.map((m) => tryDecryptDM(m))
          useChatStore.getState().setMessages(activeDMChannelId, decrypted)
          useChatStore.getState().setHasMoreMessages(activeDMChannelId, hasMore)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeDMChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeDMChannelId]: 0 },
      }))

      socketRef.current?.emit('channel:join', activeDMChannelId)
      socketRef.current?.emit('dm:read', { channelId: activeDMChannelId }, (res: { last_read_at?: number }) => {
        if (cancelled) return
        if (res?.last_read_at) {
          useChatStore.getState().setChannelLastReadAt(activeDMChannelId, res.last_read_at)
        }
      })

      return () => {
        cancelled = true
        socketRef.current?.emit('channel:leave', activeDMChannelId)
        socketRef.current?.emit('typing:stop', { channelId: activeDMChannelId })
      }
    }
  }, [activeDMChannelId, tryDecryptDM])

  useEffect(() => {
    if (!activeDMChannelId) return
    const store = useChatStore.getState()
    const msgs = store.messages[activeDMChannelId]
    if (!msgs || msgs.length === 0) return
    const decrypted = msgs.map((m) => tryDecryptDM(m))
    const needsUpdate = decrypted.some((d, i) => d.content !== msgs[i].content)
    if (needsUpdate) {
      store.setMessages(activeDMChannelId, decrypted)
    }
  }, [dmChannels, tryDecryptDM, activeDMChannelId])

  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
    }
  }, [pendingPreviewUrl])

  const loadMoreMessages = useCallback(() => {
    const channelId = activeChannelId || activeDMChannelId
    if (!channelId || !session) return
    const store = useChatStore.getState()
    const channelMessages = store.messages[channelId] || []
    if (!store.hasMoreMessages[channelId] || channelMessages.length === 0) return
    const oldestId = channelMessages[0].id
    if (!oldestId) return
    store.setHasMoreMessages(channelId, false)
    ;(async () => {
      try {
        const { messages: olderMsgs, hasMore } = activeDMChannelId
          ? await fetchDMMessages(session.url, channelId, 50, oldestId)
          : await fetchMessages(session.url, channelId, 50, oldestId)
        const decrypted = activeDMChannelId ? olderMsgs.map(m => tryDecryptDM(m)) : olderMsgs
        store.prependMessages(channelId, decrypted)
        store.setHasMoreMessages(channelId, hasMore)
      } catch (err) {
        console.error('Failed to load more messages:', err)
        store.setHasMoreMessages(channelId, true)
      }
    })()
  }, [activeChannelId, activeDMChannelId, session, tryDecryptDM])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(v => !v)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    return () => {
      if (typingTimeout.current) {
        clearTimeout(typingTimeout.current)
      }
    }
  }, [])

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
      if (typingTimeout.current) {
        clearTimeout(typingTimeout.current)
      } else {
        socketRef.current?.emit('typing:start', { channelId })
      }
      typingTimeout.current = setTimeout(() => {
        socketRef.current?.emit('typing:stop', { channelId })
        typingTimeout.current = null
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
        message = await sendMessage(session.url, activeChannelId, input.trim(), attIds, replyTo?.messageId)
        setPendingAttachmentId(null)
      } else if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
        const otherPubKey = await resolveRecipientPublicKey(activeDM)
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
        message = await sendDMMessage(session.url, activeDMChannelId, content, encrypted)
        if (encrypted) {
          message = { ...message, content: input.trim() }
        }
      } else {
        return
      }
      addMessage(message.channel_id || channelId, message)
      setInput('')
      setReplyTo(null)
      setSendError(null)
      if ('vibrate' in navigator) navigator.vibrate(10)
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

    const targetChannelId = activeChannelId || activeDMChannelId
    if (!targetChannelId) return

    setUploading(true)
    setUploadProgress(0)
    try {
      const result = await uploadAttachment(session.url, targetChannelId, pendingFile, (pct) => setUploadProgress(pct))
      setPendingAttachmentId(result.id)
      const attachmentText = `![${result.filename}](${result.url})`
      const text = input.trim()
      const attIds = [result.id]

      let message: Message
      if (activeChannelId) {
        message = await sendMessage(
          session.url, activeChannelId,
          text ? text + '\n' + attachmentText : attachmentText,
          attIds,
        )
      } else if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
        const otherPubKey = await resolveRecipientPublicKey(activeDM)
        const secKey = getSecretKey()
        const finalText = text ? text + '\n' + attachmentText : attachmentText
        let content: string
        let encrypted = false
        if (otherPubKey && secKey) {
          const enc = encryptDM(finalText, otherPubKey, secKey)
          content = JSON.stringify(enc)
          encrypted = true
        } else {
          content = finalText
        }
        message = await sendDMMessage(session.url, activeDMChannelId, content, encrypted, attIds)
        if (encrypted) {
          message = { ...message, content: finalText }
        }
      } else {
        return
      }
      addMessage(message.channel_id || targetChannelId, message)
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

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (!session) return
    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return
    try {
      if (activeDMChannelId) {
        await deleteDMMessage(session.url, messageId)
      } else {
        await deleteMessage(session.url, messageId)
      }
    } catch (err) { console.error('Failed to delete message:', err) }
  }, [session, activeChannelId, activeDMChannelId])

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) {
      setIsDragOver(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setPendingFile(files[0])
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
      const isImage = files[0].type.startsWith('image/')
      setPendingPreviewUrl(isImage ? URL.createObjectURL(files[0]) : null)
    }
  }

  const handleEditMessage = useCallback(async (messageId: string, content: string) => {
    if (!session) return
    const channelId = activeChannelId || activeDMChannelId
    if (!channelId) return
    try {
      if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId)
        if (!activeDM) return
        const otherPubKey = await resolveRecipientPublicKey(activeDM)
        const secKey = getSecretKey()
        let sendContent = content
        let encrypted = false
        if (otherPubKey && secKey) {
          const enc = encryptDM(content, otherPubKey, secKey)
          sendContent = JSON.stringify(enc)
          encrypted = true
        }
        await editDMMessage(session.url, messageId, sendContent, encrypted)
      } else {
        await editMessage(session.url, messageId, content)
      }
    } catch (err) { console.error('Failed to edit message:', err) }
  }, [session, activeChannelId, activeDMChannelId, dmChannels, resolveRecipientPublicKey])

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const headerTitle = activeChannel?.name || activeDM?.other_display_name || 'Kizuna'
  const displayMessages = activeDMChannelId ? dmMessages : channelMessages
  useEffect(() => {
    if (atBottom) {
      lastCountAtBottom.current = displayMessages.length
    }
  }, [atBottom, displayMessages.length])

  useEffect(() => {
    lastCountAtBottom.current = displayMessages.length
  }, [activeChannelId, activeDMChannelId])
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

  const renderMessageItem = useCallback((_index: number, msg: Message) => {
    const msgIdx = displayMessages.indexOf(msg)
    const prevMsg = msgIdx > 0 ? displayMessages[msgIdx - 1] : null
    const msgDate = new Date(msg.created_at).toDateString()
    const prevDate = prevMsg ? new Date(prevMsg.created_at).toDateString() : ''
    const isOwn = msg.user_id === session?.user.id
    const isGrouped = prevMsg?.user_id === msg.user_id && !isOwn
    const messageCanDelete = isOwn || canDeleteAny

    return (
      <>
        {msgDate !== prevDate && (
          <div className="msg-bubble__date-separator">
            <span className="msg-bubble__date-label">{formatDateSeparator(new Date(msg.created_at))}</span>
          </div>
        )}
        <MessageBubble
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
          onReply={(replyMsg) => {
            setReplyTo({ messageId: replyMsg.id, username: replyMsg.display_name || replyMsg.username || 'Unknown', content: replyMsg.content })
            inputRef.current?.focus()
          }}
          onUserClick={() => {}}
          onImageClick={(imageUrl, filename) => {
            const allImages: { url: string; filename: string }[] = []
            const channelMsgs = displayMessages
            const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g
            const urlRe = /(https?:\/\/[^\s]+)/g
            for (const m of channelMsgs) {
              let match
              while ((match = imgRe.exec(m.content)) !== null) {
                const u = match[2]
                if (u.startsWith('/uploads/') || u.startsWith('/api/attachments/') || u.startsWith('/api/gifs/') || u.startsWith('http')) {
                  const resolved = session?.url && u.startsWith('/') ? `${session.url}${u}` : u
                  allImages.push({ url: resolved, filename: match[1] || 'image' })
                }
              }
              while ((match = urlRe.exec(m.content)) !== null) {
                const u = match[1]
                if (/\.(jpg|jpeg|png|gif|webp)$/i.test(u)) {
                  if (!allImages.some(a => a.url === u)) {
                    allImages.push({ url: u, filename: u.split('/').pop() || 'image' })
                  }
                }
              }
            }
            const currentIndex = allImages.findIndex(img => img.url === imageUrl)
            setLightboxImages(allImages)
            setLightboxIndex(currentIndex >= 0 ? currentIndex : 0)
          }}
        />
      </>
    )
  }, [displayMessages, session, members, canDeleteAny, activeChannelId, activeDMChannelId, setReplyTo])

  return (
    <div
      ref={chatAreaRef}
      className="chat-area"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="chat-area__drop-overlay">
          <div className="chat-area__drop-overlay-content">
            <span className="chat-area__drop-overlay-icon">&#x2913;</span>
            <span className="chat-area__drop-overlay-text">Drop files to upload</span>
          </div>
        </div>
      )}
      <div className="chat-area__header">
        {isMobile && onBackToSidebar && (
          <button
            className="chat-area__mobile-back"
            onClick={onBackToSidebar}
            aria-label="Back to channels"
          >
            <ChevronLeft className="icon-sm" />
          </button>
        )}
        <span className="chat-area__header-prefix">{activeDMChannelId ? '@' : '#'}</span>
        <h2 className="chat-area__header-title">{headerTitle}</h2>
        {activeDMChannelId && activeDM && canCall && (
          <button
            onClick={() => {
              if (dmCallStatus === 'active' && dmCallChannelId === activeDM.id) {
                onEndDMCall?.()
              } else if (dmCallStatus !== 'ringing-outgoing') {
                onStartDMCall?.(activeDM.id, activeDM.other_user_id, activeDM.other_display_name)
              }
            }}
            className={`chat-area__call-btn ${dmCallStatus === 'active' && dmCallChannelId === activeDM.id ? 'chat-area__call-btn--active' : ''}`}
            title={dmCallStatus === 'active' && dmCallChannelId === activeDM.id ? 'End call' : dmCallStatus === 'ringing-outgoing' && dmCallChannelId === activeDM.id ? 'Calling...' : 'Start call'}
            disabled={dmCallStatus === 'ringing-outgoing' && dmCallChannelId === activeDM.id}
          >
            <Phone className="icon-xs" />
          </button>
        )}
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

      {showSearch && activeChannelId && (
        <SearchBar
          channelId={activeChannelId}
          onClose={() => setShowSearch(false)}
          onJumpToMessage={() => setShowSearch(false)}
        />
      )}

      <div className="chat-area__messages" role="log" aria-label="Messages" aria-live="polite">
        {loading && (
          <>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton--message">
                <Skeleton variant="circle" width={40} height={40} />
                <div className="skeleton--message-body">
                  <Skeleton variant="text" width={120} />
                  <Skeleton variant="text" width={200 + (i % 3) * 80} />
                  {i % 2 === 0 && <Skeleton variant="text" width={140} />}
                </div>
              </div>
            ))}
          </>
        )}
        {!loading && displayMessages.length === 0 && (
          <p className="chat-area__loading">No messages yet. Be the first to send one!</p>
        )}
        {!loading && displayMessages.length > 0 && (
          <Virtuoso
            key={activeChannelId || activeDMChannelId}
            ref={virtuosoRef}
            data={displayMessages}
            itemContent={renderMessageItem}
            followOutput={(isAtBottom) => isAtBottom ? "smooth" : false}
            atBottomStateChange={(isAtBottom) => setAtBottom(isAtBottom)}
            startReached={loadMoreMessages}
            initialTopMostItemIndex={displayMessages.length > 0 ? displayMessages.length - 1 : 0}
            style={{ flex: 1 }}
            components={{
              Footer: () => typingText ? <div className="chat-area__typing">{typingText}</div> : null,
            }}
          />
        )}
        {!atBottom && displayMessages.length > lastCountAtBottom.current && (
          <button
            className="chat-area__scroll-bottom"
            onClick={() => { virtuosoRef.current?.scrollToIndex(displayMessages.length - 1); lastCountAtBottom.current = displayMessages.length }}
            title="Scroll to bottom"
          >
            ↓ New messages
          </button>
        )}
      </div>

      <div className="chat-area__input-bar">
        {suggestions.length > 0 && (
          <div className="chat-area__mention-suggestions">
            {suggestions.slice(0, 8).map((u, i) => {
              const mentionableRole = mentionableRoles.find(r => r.name === u)
              const isRole = !!mentionableRole
              return (
              <button
                key={u}
                ref={(el) => { suggestionRefs.current[i] = el }}
                onMouseDown={(e) => { e.preventDefault(); insertMention(u) }}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`chat-area__mention-suggestion ${i === selectedIndex ? 'chat-area__mention-suggestion--selected' : ''}`}
              >
                {isRole && <span className="chat-area__mention-role-dot" style={{ backgroundColor: mentionableRole.color }} />}
                <span className="chat-area__mention-prefix">@</span>
                {u}
                {isRole && <span className="chat-area__mention-group-tag">role</span>}
                {(u === 'everyone' || u === 'here') && <span className="chat-area__mention-group-tag">group</span>}
              </button>
              )
            })}
          </div>
        )}

        {replyTo && (
          <div className="chat-area__reply-bar">
            <div className="chat-area__reply-bar-content">
              <span className="chat-area__reply-bar-label">Replying to</span>
              <span className="chat-area__reply-bar-username">@{replyTo.username}</span>
              <span className="chat-area__reply-bar-preview">
                {replyTo.content.length > 80 ? replyTo.content.slice(0, 80) + '...' : replyTo.content}
              </span>
            </div>
            <button
              className="chat-area__reply-bar-close"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
            >
              x
            </button>
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
          <button className="chat-area__attach-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading} title="Attach file" aria-label="Attach file">
            <Paperclip size={16} />
          </button>
          <button className="chat-area__gif-btn" onClick={() => setGifPickerOpen(true)} title="GIFs & Stickers" aria-label="GIFs and stickers">
            <Sticker size={16} />
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
            aria-label={`Message ${activeDMChannelId ? activeDM?.other_display_name || 'direct messages' : activeChannel?.name || 'channel'}`}
          />
          <button className="chat-area__send-btn" onClick={handleSend} disabled={((!input.trim() && !pendingFile) || uploading || cantWrite)} aria-label="Send message">
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
            
            onSelect={(url, displayName, type) => {
              setInput(prev => prev + `![${type}:${displayName}](${url})`)
              setGifPickerOpen(false)
              inputRef.current?.focus()
            }}
            onClose={() => setGifPickerOpen(false)}
          />
        )}
      </div>

      {lightboxImages && (
        <Lightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxImages(null)}
        />
      )}
    </div>
  )
}
