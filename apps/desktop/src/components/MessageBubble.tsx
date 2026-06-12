import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Pencil } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Message, Member } from '@kizuna/shared'
import { reactToMessage, unreactToMessage } from '@kizuna/shared'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import ReactionPills from './ReactionPills'
import ReactionBar from './ReactionBar'
import ReactionPicker from './ReactionPicker'
import '../styles/message-bubble.css'

interface MessageBubbleProps {
  message: Message
  isOwn: boolean
  isGrouped: boolean
  members: Member[]
  currentUsername?: string
  canDelete: boolean
  onDelete: (messageId: string) => void
  canEdit: boolean
  onEdit: (messageId: string, content: string) => void
  serverUrl?: string
}

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(url) || /\/api\/gifs\//.test(url)
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
    if (url.startsWith('/uploads/') || url.startsWith('/api/attachments/') || url.startsWith('/api/gifs/') || url.startsWith('http')) {
      attachments.push({ filename, url })
      text = text.replace(match[0], '')
    }
  }

  const urlRegex = /(https?:\/\/[^\s]+)/g
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[1]
    if (isImageUrl(url) || isVideoUrl(url) || isAudioUrl(url) || url.endsWith('.pdf')) {
      if (!attachments.some((a) => a.url === url)) {
        attachments.push({ filename: url.split('/').pop() || 'file', url })
      }
    }
  }

  return { text: text.trim(), attachments }
}

function renderMessageHtml(content: string, currentUsername?: string): string {
  if (!content) return ''

  let html = content.replace(
    /@(everyone|here|[\w.\-]+)/gi,
    (match) => {
      const tag = match.slice(1).toLowerCase()
      const isMe = currentUsername && tag === currentUsername.toLowerCase()
      const isGroup = tag === 'everyone' || tag === 'here'
      const cls = isMe ? 'msg-bubble__mention--self' : isGroup ? 'msg-bubble__mention--group' : 'msg-bubble__mention--user'
      return `<span class="${cls}">${match}</span>`
    }
  )

  const raw = marked.parse(html, { breaks: true, gfm: true }) as string

  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['span', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
    ALLOWED_ATTR: ['class', 'href', 'target', 'rel'],
  })

  return clean
}

function AttachmentPreview({ url, filename, serverUrl, isMediaOnly }: { url: string; filename: string; serverUrl?: string; isMediaOnly?: boolean }) {
  const resolvedUrl = serverUrl && url.startsWith('/') ? `${serverUrl}${url}` : url
  const [expanded, setExpanded] = useState(false)
  const [loadError, setLoadError] = useState(false)

  if (loadError) {
    return (
      <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="msg-bubble__attachment-link">
        <span className="msg-bubble__attachment-filename">{filename}</span>
      </a>
    )
  }

  if (isImageUrl(url)) {
    const isGifUrl = /\/api\/gifs\//.test(url)
    return (
      <div className={`msg-bubble__attachment-image-wrap ${isMediaOnly ? 'msg-bubble__attachment-image-wrap--media-only' : ''}`} onClick={() => setExpanded(!expanded)}>
        <img
          src={resolvedUrl}
          alt={filename}
          className={`msg-bubble__attachment-image ${expanded ? 'msg-bubble__attachment-image--expanded' : ''} ${isMediaOnly ? 'msg-bubble__attachment-image--media-only' : ''} ${isGifUrl ? 'msg-bubble__attachment-image--sticker' : ''}`}
          onError={() => setLoadError(true)}
        />
        {!expanded && !isMediaOnly && <div className="msg-bubble__attachment-expand-hint">expand</div>}
      </div>
    )
  }

  if (isVideoUrl(url)) {
    return <video src={resolvedUrl} controls className={`msg-bubble__attachment-video ${isMediaOnly ? 'msg-bubble__attachment-video--media-only' : ''}`} onError={() => setLoadError(true)} />
  }

  if (isAudioUrl(url)) {
    return <audio src={resolvedUrl} controls className="msg-bubble__attachment-audio" onError={() => setLoadError(true)} />
  }

  return (
    <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="msg-bubble__attachment-link">
      <span className="msg-bubble__attachment-filename">{filename}</span>
    </a>
  )
}

export default function MessageBubble({
  message,
  isOwn,
  isGrouped,
  members,
  currentUsername,
  canDelete,
  onDelete,
  canEdit,
  onEdit,
  serverUrl,
}: MessageBubbleProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [barHovered, setBarHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [barMounted, setBarMounted] = useState(false)
  const barTimer = useRef<ReturnType<typeof setTimeout>>()
  const [barPos, setBarPos] = useState<{ top: number; left: number } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLTextAreaElement>(null)
  const displayName = message.display_name || message.username || 'Unknown'
  const { text, attachments } = parseAttachments(message.content)
  const isMediaOnly = !text && attachments.length > 0
  const isStickerOnly = isMediaOnly && attachments.length > 0 && attachments.every(a => /\/api\/gifs\//.test(a.url))
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const session = useServerStore((s) => s.activeSession)

  useEffect(() => {
    if (hovered || pickerOpen || barHovered) {
      clearTimeout(barTimer.current)
      setBarMounted(true)
    } else {
      barTimer.current = setTimeout(() => setBarMounted(false), 180)
    }
    return () => clearTimeout(barTimer.current)
  }, [hovered, pickerOpen, barHovered])

  useEffect(() => {
    if (!barMounted || !contentRef.current) { setBarPos(null); return }
    const update = () => {
      if (!contentRef.current) return
      const r = contentRef.current.getBoundingClientRect()
      setBarPos({ top: r.bottom + 25, left: r.left })
    }
    update()
    const scrollContainer = contentRef.current.closest('.chat-area__messages')
    window.addEventListener('resize', update)
    scrollContainer?.addEventListener('scroll', update, { passive: true })
    return () => {
      window.removeEventListener('resize', update)
      scrollContainer?.removeEventListener('scroll', update)
    }
  }, [barMounted])

  const showMeta = hovered || !!message.edited_at || confirmDelete || editing

  const handleToggleReaction = useCallback(async (reactionKey: string, reactionType: string) => {
    if (!session) return
    try {
      let res: { reactions: any[] }
      const reactions = message.reactions || []
      const existing = reactions.find(r => r.reaction_key === reactionKey && r.reaction_type === reactionType)
      const hasReacted = existing?.users.some(u => u.user_id === session.user.id)

      if (hasReacted) {
        res = await unreactToMessage(session.url, session.token, message.id, reactionKey)
      } else {
        res = await reactToMessage(session.url, session.token, message.id, reactionKey, reactionType)
      }
      useChatStore.getState().updateMessageReactions(message.channel_id, message.id, res.reactions)
    } catch {}
  }, [session, message.id, message.reactions, message.channel_id])

  const startEdit = () => {
    setEditing(true)
    setEditContent(message.content)
    setConfirmDelete(false)
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditContent('')
  }

  const saveEdit = () => {
    const trimmed = editContent.trim()
    if (!trimmed || trimmed === message.content) {
      cancelEdit()
      return
    }
    onEdit(message.id, trimmed)
    setEditing(false)
    setEditContent('')
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      saveEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  useEffect(() => {
    const el = editInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 300)}px`
  })

  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length)
    }
  }, [editing])

  return (
    <div className={`msg-bubble__row ${isOwn ? 'msg-bubble__row--own' : ''} ${isGrouped ? 'msg-bubble__row--grouped' : ''} ${isMediaOnly ? 'msg-bubble__row--media-only' : ''}`}>
      {!isOwn && !isGrouped && !isMediaOnly && (
        <div className="msg-bubble__avatar">
          {message.avatar ? (
            <img src={message.avatar} alt="" className="msg-bubble__avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          ) : displayName[0]?.toUpperCase()}
        </div>
      )}
      {!isOwn && isGrouped && !isMediaOnly && <div className="msg-bubble__avatar-spacer" />}

      <div
        className="msg-bubble__content"
        ref={contentRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          className={`msg-bubble__bubble ${isOwn ? 'msg-bubble__bubble--own' : 'msg-bubble__bubble--other'} ${isGrouped && !isOwn ? 'msg-bubble__bubble--grouped' : ''} ${editing ? 'msg-bubble__bubble--editing' : ''} ${isMediaOnly ? 'msg-bubble__bubble--media-only' : ''} ${isStickerOnly ? 'msg-bubble__bubble--sticker-only' : ''}`}
        >
          {!isOwn && !isGrouped && !isMediaOnly && <p className="msg-bubble__author">{displayName}</p>}
          {editing ? (
            <textarea
              ref={editInputRef}
              className="msg-bubble__edit-input"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
            />
          ) : (
            text && <div className="msg-bubble__text" dangerouslySetInnerHTML={{ __html: renderMessageHtml(text, currentUsername) }} />
          )}
          {attachments.length > 0 && attachments.map((att, i) => (
            <AttachmentPreview key={i} url={att.url} filename={att.filename} serverUrl={serverUrl} isMediaOnly={isMediaOnly} />
          ))}
          <div className={`msg-bubble__meta ${showMeta ? 'msg-bubble__meta--visible' : ''} ${editing ? 'msg-bubble__meta--editing' : ''}`}>
            {hovered && <span className="msg-bubble__time">{time}</span>}
            {message.edited_at && <span className="msg-bubble__edited">(edited)</span>}
            {editing ? (
              <span className="msg-bubble__edit-actions">
                <button className="msg-bubble__edit-action-btn msg-bubble__edit-action-btn--save" onClick={saveEdit}>save</button>
                <button className="msg-bubble__edit-action-btn msg-bubble__edit-action-btn--cancel" onClick={cancelEdit}>cancel</button>
              </span>
            ) : (
              <>
                {canEdit && !isStickerOnly && (
                  <button className="msg-bubble__edit-btn" onClick={startEdit} title="Edit message">
                    <Pencil size={12} />
                  </button>
                )}
                {canDelete && confirmDelete ? (
                  <span className="msg-bubble__delete-confirm">
                    <button className="msg-bubble__delete-confirm-btn msg-bubble__delete-confirm-btn--yes" onClick={() => { onDelete(message.id); setConfirmDelete(false) }}>confirm</button>
                    <button className="msg-bubble__delete-confirm-btn msg-bubble__delete-confirm-btn--no" onClick={() => setConfirmDelete(false)}>cancel</button>
                  </span>
                ) : canDelete && !isStickerOnly ? (
                  <button className="msg-bubble__delete-btn" onClick={() => setConfirmDelete(true)} title="Delete message">
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <ReactionPills
          reactions={message.reactions || []}
          currentUserId={session?.user.id}
          serverUrl={serverUrl}
          onToggle={handleToggleReaction}
        />

        {barMounted && barPos && session && createPortal(
          <div
            className="msg-bubble__react-bar-portal"
            style={{ position: 'fixed', top: barPos.top, left: barPos.left, zIndex: 200 }}
            onMouseEnter={() => setBarHovered(true)}
            onMouseLeave={() => setBarHovered(false)}
          >
            <div
              className="msg-bubble__react-bar-bridge"
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                height: 25,
              }}
              onMouseEnter={() => setBarHovered(true)}
            />
            <ReactionBar
              serverUrl={session.url}
              token={session.token}
              onReact={handleToggleReaction}
              onAddClick={() => setPickerOpen(true)}
              visible={hovered || pickerOpen || barHovered}
            />
          </div>,
          document.body,
        )}

        {pickerOpen && session && (
          <ReactionPicker
            serverUrl={session.url}
            token={session.token}
            onSelect={(key, type) => {
              handleToggleReaction(key, type)
              setPickerOpen(false)
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
