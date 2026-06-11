import { useState, useRef, useEffect } from 'react'
import { Trash2, Pencil } from 'lucide-react'
import type { Message, Member } from '@kizuna/shared'
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
    if (url.startsWith('/uploads/') || url.startsWith('/api/attachments/') || url.startsWith('http')) {
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
      const cls = isMe ? 'msg-bubble__mention--self' : isGroup ? 'msg-bubble__mention--group' : 'msg-bubble__mention--user'
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
      <a href={url} target="_blank" rel="noopener noreferrer" className="msg-bubble__attachment-link">
        <span className="msg-bubble__attachment-filename">{filename}</span>
      </a>
    )
  }

  if (isImageUrl(url)) {
    return (
      <div className="msg-bubble__attachment-image-wrap" onClick={() => setExpanded(!expanded)}>
        <img
          src={url}
          alt={filename}
          className={`msg-bubble__attachment-image ${expanded ? 'msg-bubble__attachment-image--expanded' : ''}`}
          onError={() => setLoadError(true)}
        />
        {!expanded && <div className="msg-bubble__attachment-expand-hint">expand</div>}
      </div>
    )
  }

  if (isVideoUrl(url)) {
    return <video src={url} controls className="msg-bubble__attachment-video" onError={() => setLoadError(true)} />
  }

  if (isAudioUrl(url)) {
    return <audio src={url} controls className="msg-bubble__attachment-audio" onError={() => setLoadError(true)} />
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="msg-bubble__attachment-link">
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
}: MessageBubbleProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const editInputRef = useRef<HTMLTextAreaElement>(null)
  const displayName = message.display_name || message.username || 'Unknown'
  const { text, attachments } = parseAttachments(message.content)
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const showMeta = hovered || !!message.edited_at || confirmDelete || editing

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
    if (editing && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length)
    }
  }, [editing])

  return (
    <div className={`msg-bubble__row ${isOwn ? 'msg-bubble__row--own' : ''} ${isGrouped ? 'msg-bubble__row--grouped' : ''}`}>
      {!isOwn && !isGrouped && (
        <div className="msg-bubble__avatar">
          {message.avatar ? (
            <img src={message.avatar} alt="" className="msg-bubble__avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          ) : displayName[0]?.toUpperCase()}
        </div>
      )}
      {!isOwn && isGrouped && <div className="msg-bubble__avatar-spacer" />}

      <div
        className={`msg-bubble__bubble ${isOwn ? 'msg-bubble__bubble--own' : 'msg-bubble__bubble--other'} ${isGrouped && !isOwn ? 'msg-bubble__bubble--grouped' : ''}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {!isOwn && !isGrouped && <p className="msg-bubble__author">{displayName}</p>}
        {editing ? (
          <textarea
            ref={editInputRef}
            className="msg-bubble__edit-input"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={handleEditKeyDown}
            rows={3}
          />
        ) : (
          text && <p className="msg-bubble__text">{renderMentions(text, members, currentUsername)}</p>
        )}
        {attachments.length > 0 && attachments.map((att, i) => (
          <AttachmentPreview key={i} url={att.url} filename={att.filename} />
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
              {canEdit && (
                <button className="msg-bubble__edit-btn" onClick={startEdit} title="Edit message">
                  <Pencil size={12} />
                </button>
              )}
              {canDelete && confirmDelete ? (
                <span className="msg-bubble__delete-confirm">
                  <button className="msg-bubble__delete-confirm-btn msg-bubble__delete-confirm-btn--yes" onClick={() => { onDelete(message.id); setConfirmDelete(false) }}>confirm</button>
                  <button className="msg-bubble__delete-confirm-btn msg-bubble__delete-confirm-btn--no" onClick={() => setConfirmDelete(false)}>cancel</button>
                </span>
              ) : canDelete ? (
                <button className="msg-bubble__delete-btn" onClick={() => setConfirmDelete(true)} title="Delete message">
                  <Trash2 size={12} />
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
