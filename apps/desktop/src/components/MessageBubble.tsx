import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Pencil } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import c from 'highlight.js/lib/languages/c'
import go from 'highlight.js/lib/languages/go'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import type { Message } from '@kizuna/shared'
import { reactToMessage, unreactToMessage } from '@kizuna/shared'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { Avatar } from './ui'
import { useMobile } from '../hooks/useMobile'
import { useHaptics } from '../hooks/useHaptics'
import { useLongPress } from '../hooks/useLongPress'
import ReactionPills from './ReactionPills'
import ReactionBar from './ReactionBar'
import ReactionPicker from './ReactionPicker'
import ContextMenu, { type ContextMenuSection } from './ContextMenu'
import UserProfileCard from './UserProfileCard'
import EmbedCard from './EmbedCard'
import VoiceMessagePlayer from './VoiceMessagePlayer'
import './MessageBubble.css'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', c)
hljs.registerLanguage('go', go)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

interface MessageBubbleProps {
  message: Message
  isOwn: boolean
  isGrouped: boolean
  currentUsername?: string
  canDelete: boolean
  onDelete: (messageId: string) => void
  canEdit: boolean
  onEdit: (messageId: string, content: string) => void
  serverUrl?: string
  onReply?: (message: Message) => void
  onPin?: (messageId: string) => void
  onUnpin?: (messageId: string) => void
  isPinned?: boolean
  onCreateThread?: (messageId: string, name: string) => void
  onImageClick?: (imageUrl: string, filename: string) => void
}

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp)$/i.test(url) || /\/api\/gifs\//.test(url)
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4)$/i.test(url)
}

function isAudioUrl(url: string): boolean {
  return /\.(mp3|ogg|wav|webm)$/i.test(url)
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


function highlightCodeBlocks(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('pre code').forEach((block) => {
      const langClass = Array.from(block.classList).find((c) => c.startsWith('language-'))
      const lang = langClass ? langClass.replace('language-', '') : ''
      const text = block.textContent || ''
      try {
        if (lang && hljs.getLanguage(lang)) {
          block.innerHTML = hljs.highlight(text, { language: lang }).value
        } else if (text.trim().length > 0) {
          block.innerHTML = hljs.highlightAuto(text).value
        }
      } catch {
        block.textContent = text
      }
      block.classList.add('hljs')
      if (lang) block.classList.add('language-' + lang)
    })
    return doc.body.innerHTML
  } catch {
    return html
  }
}

function renderMessageHtml(content: string, currentUsername?: string): string {
  if (!content) return ''

  const withMentions = content.replace(
    /@(everyone|here|[\w.-]+)/gi,
    (match) => {
      const tag = match.slice(1).toLowerCase()
      const isMe = currentUsername && tag === currentUsername.toLowerCase()
      const isGroup = tag === 'everyone' || tag === 'here'
      const cls = isMe ? 'msg-bubble__mention--self' : isGroup ? 'msg-bubble__mention--group' : 'msg-bubble__mention--user'
      return `<span class="${cls}">${match}</span>`
    }
  )

  // Discord-style spoilers: ||hidden text|| → click to reveal.
  const html = withMentions.replace(
    /\|\|([\s\S]+?)\|\|/g,
    (_match, inner) => `<span class="msg-bubble__spoiler">${inner}</span>`,
  )

  const raw = marked.parse(html, { breaks: true, gfm: true }) as string

  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['span', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
    ALLOWED_ATTR: ['class', 'href', 'target', 'rel'],
  })

  return highlightCodeBlocks(clean)
}

function AttachmentPreview({ url, filename, serverUrl, isMediaOnly, onImageClick }: { url: string; filename: string; serverUrl?: string; isMediaOnly?: boolean; onImageClick?: (url: string, filename: string) => void }) {
  const resolvedUrl = serverUrl && url.startsWith('/') ? `${serverUrl}${url}` : url
  const [loadError, setLoadError] = useState(false)

  const hasTypePrefix = /^(gif|sticker):/.test(filename)
  const isSticker = hasTypePrefix ? /^sticker:/.test(filename) : /\/api\/gifs\//.test(url)
  const displayFilename = hasTypePrefix ? filename.slice(filename.indexOf(':') + 1) : filename

  if (loadError) {
    return (
      <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="msg-bubble__attachment-link">
        <span className="msg-bubble__attachment-filename">{displayFilename}</span>
      </a>
    )
  }

  if (isImageUrl(url)) {
    return (
      <div
        className={`msg-bubble__attachment-image-wrap ${isMediaOnly ? 'msg-bubble__attachment-image-wrap--media-only' : ''}`}
        onClick={() => onImageClick ? onImageClick(resolvedUrl, displayFilename) : null}
      >
        <img
          src={resolvedUrl}
          alt={displayFilename}
          loading="lazy"
          decoding="async"
          className={`msg-bubble__attachment-image ${isMediaOnly ? 'msg-bubble__attachment-image--media-only' : ''} ${isSticker ? 'msg-bubble__attachment-image--sticker' : ''}`}
          onError={() => setLoadError(true)}
        />
      </div>
    )
  }

  if (isAudioUrl(url)) {
    return <VoiceMessagePlayer url={resolvedUrl} />
  }

  if (isVideoUrl(url)) {
    return <video src={resolvedUrl} controls className={`msg-bubble__attachment-video ${isMediaOnly ? 'msg-bubble__attachment-video--media-only' : ''}`} onError={() => setLoadError(true)} />
  }

  return (
    <a href={resolvedUrl} target="_blank" rel="noopener noreferrer" className="msg-bubble__attachment-link">
      <span className="msg-bubble__attachment-filename">{displayFilename}</span>
    </a>
  )
}

function MessageBubble({
  message,
  isOwn,
  isGrouped,
  currentUsername,
  canDelete,
  onDelete,
  canEdit,
  onEdit,
  serverUrl,
  onReply,
  onPin,
  onUnpin,
  isPinned,
  onCreateThread,
  onImageClick,
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
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [showProfileCard, setShowProfileCard] = useState(false)
  const profileAnchorRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLTextAreaElement>(null)
  const isMobile = useMobile()
  const haptics = useHaptics()
  const [mobileActionsVisible, setMobileActionsVisible] = useState(false)

  const longPressHandlers = useLongPress({
    onLongPress: useCallback(() => {
      if (!isMobile) return
      haptics.longPress()
      const rect = contentRef.current?.getBoundingClientRect()
      if (rect) {
        setContextMenuPos({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      }
    }, [isMobile, haptics]),
    onTap: useCallback(() => {
      if (!isMobile) return
      haptics.tap()
      setMobileActionsVisible((v) => !v)
    }, [isMobile, haptics]),
    enabled: isMobile,
  })
  const displayName = message.display_name || message.username || 'Unknown'
  const { text, attachments } = useMemo(() => parseAttachments(message.content), [message.content])
  const renderedHtml = useMemo(() => renderMessageHtml(text, currentUsername), [text, currentUsername])

  const handleSpoilerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const spoiler = (e.target as HTMLElement).closest('.msg-bubble__spoiler')
    if (spoiler) spoiler.classList.toggle('msg-bubble__spoiler--revealed')
  }
  const isMediaOnly = !text && attachments.length > 0
  const isStickerOnly = isMediaOnly && attachments.length > 0 && attachments.every(a => {
    const hasPrefix = /^(gif|sticker):/.test(a.filename)
    if (hasPrefix) return /^sticker:/.test(a.filename)
    return /\/api\/gifs\//.test(a.url)
  })
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const session = useServerStore((s) => s.activeSession)
  const authorStickerId = useChatStore((s) => s.members.find((m) => m.id === message.user_id)?.status_sticker_id)

  useEffect(() => {
    const show = isMobile ? mobileActionsVisible || pickerOpen : (hovered || pickerOpen || barHovered)
    if (show) {
      clearTimeout(barTimer.current)
      setBarMounted(true)
    } else {
      barTimer.current = setTimeout(() => setBarMounted(false), 180)
    }
    return () => clearTimeout(barTimer.current)
  }, [hovered, pickerOpen, barHovered, isMobile, mobileActionsVisible])

  useEffect(() => {
    if (!barMounted || !contentRef.current) { setBarPos(null); return }
    const el = contentRef.current
    const update = () => {
      if (!el) return
      const r = el.getBoundingClientRect()
      setBarPos({ top: r.bottom + 25, left: r.left })
    }
    update()
    const scrollContainer = el.closest('.chat-area__messages')
    window.addEventListener('resize', update)
    scrollContainer?.addEventListener('scroll', update, { passive: true })
    return () => {
      window.removeEventListener('resize', update)
      scrollContainer?.removeEventListener('scroll', update)
    }
  }, [barMounted])

  const showMeta = isMobile ? (mobileActionsVisible || editing) : (hovered || !!message.edited_at || confirmDelete || editing)

  const handleToggleReaction = useCallback(async (reactionKey: string, reactionType: string) => {
    if (!session) return
    const reactions = message.reactions || []
    const existing = reactions.find(r => r.reaction_key === reactionKey && r.reaction_type === reactionType)
    const hasReacted = existing?.users.some(u => u.user_id === session.user.id)
    haptics.medium()
    try {
      if (hasReacted) {
        await unreactToMessage(session.url, message.id, reactionKey)
      } else {
        await reactToMessage(session.url, message.id, reactionKey, reactionType)
      }
    } catch (err) {
      console.error('Reaction toggle failed:', err)
    }
  }, [session, message.id, message.reactions, message.channel_id, haptics])

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
  }, [editContent])

  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.setSelectionRange(editInputRef.current.value.length, editInputRef.current.value.length)
    }
  }, [editing])

  function getContextMenuSections(): ContextMenuSection[] {
    const sections: ContextMenuSection[] = []

    const mainItems: typeof sections[0]['items'] = []

    if (onReply) {
      mainItems.push({
        label: 'Reply',
        onClick: () => onReply(message),
        shortcut: 'R',
      })
    }

    if (onPin && !isPinned) {
      mainItems.push({
        label: 'Pin Message',
        onClick: () => onPin(message.id),
      })
    }

    if (onUnpin && isPinned) {
      mainItems.push({
        label: 'Unpin Message',
        onClick: () => onUnpin(message.id),
      })
    }

    if (onCreateThread && !message.thread_id) {
      mainItems.push({
        label: 'Create Thread',
        onClick: () => {
          const name = message.content.slice(0, 50).replace(/\n/g, ' ') || 'Thread'
          onCreateThread(message.id, name)
        },
      })
    }

    mainItems.push({
      label: 'Copy Text',
      onClick: () => {
        const rawText = message.content || ''
        navigator.clipboard.writeText(rawText).catch(() => {})
      },
      shortcut: 'Ctrl+C',
    })

    mainItems.push({
      label: 'Copy Message ID',
      onClick: () => {
        navigator.clipboard.writeText(message.id).catch(() => {})
      },
    })

    if (mainItems.length > 0) {
      sections.push({ items: mainItems })
    }

    const actionItems: typeof sections[0]['items'] = []

    if (canEdit && !isStickerOnly) {
      actionItems.push({
        label: 'Edit',
        onClick: startEdit,
        shortcut: 'E',
      })
    }

    if (canDelete) {
      actionItems.push({
        label: 'Delete',
        onClick: () => { onDelete(message.id); setConfirmDelete(false) },
        danger: true,
        shortcut: 'Del',
      })
    }

    if (actionItems.length > 0) {
      sections.push({ items: actionItems })
    }

    return sections
  }

  function handleMessageContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
  }

  return (
    <div className={`msg-bubble__row ${isOwn ? 'msg-bubble__row--own' : ''} ${isGrouped ? 'msg-bubble__row--grouped' : ''} ${isMediaOnly ? 'msg-bubble__row--media-only' : ''}`}>
      {!isOwn && !isGrouped && (
        <Avatar
          className="msg-bubble__avatar"
          src={message.avatar}
          name={displayName}
          size={36}
          bgColor="var(--bg-tertiary)"
          stickerId={authorStickerId}
          serverUrl={session?.url}
        />
      )}
      {!isOwn && isGrouped && <div className="msg-bubble__avatar-spacer" />}

      <div
        className="msg-bubble__content"
        ref={contentRef}
        onMouseEnter={() => { if (!isMobile) setHovered(true) }}
        onMouseLeave={() => { if (!isMobile) setHovered(false) }}
        {...(isMobile ? longPressHandlers : {})}
      >
        <div
          className={`msg-bubble__bubble ${isOwn ? 'msg-bubble__bubble--own' : 'msg-bubble__bubble--other'} ${isGrouped && !isOwn ? 'msg-bubble__bubble--grouped' : ''} ${editing ? 'msg-bubble__bubble--editing' : ''} ${isMediaOnly ? 'msg-bubble__bubble--media-only' : ''} ${isStickerOnly ? 'msg-bubble__bubble--sticker-only' : ''}`}
          onContextMenu={handleMessageContextMenu}
        >
          {message.reply_to_message_id && message.reply_to_username && (
            <div className="msg-bubble__reply-preview">
              <span className="msg-bubble__reply-preview-line" />
              <span className="msg-bubble__reply-preview-username">@{message.reply_to_username}</span>
              <span className="msg-bubble__reply-preview-text">
                {message.reply_to_content
                  ? message.reply_to_content.length > 120
                    ? message.reply_to_content.slice(0, 120) + '...'
                    : message.reply_to_content
                  : '...'}
              </span>
            </div>
          )}
          {!isOwn && !isGrouped && (
            <p
              className="msg-bubble__author"
              onClick={(e) => { profileAnchorRef.current = e.currentTarget as HTMLElement; setShowProfileCard(true) }}
              style={{ cursor: 'pointer' }}
            >
              {displayName}
            </p>
          )}
          {editing ? (
            <textarea
              ref={editInputRef}
              className="msg-bubble__edit-input"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleEditKeyDown}
            />
          ) : (
            text && <div className="msg-bubble__text" onClick={handleSpoilerClick} dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          )}
          {attachments.length > 0 && attachments.map((att, i) => (
            <AttachmentPreview key={i} url={att.url} filename={att.filename} serverUrl={serverUrl} isMediaOnly={isMediaOnly} onImageClick={onImageClick} />
          ))}
          {text && (() => {
            const urls = (text.match(/(https?:\/\/[^\s<]+)/g) || [])
              .filter(u => !/\.(jpg|jpeg|png|gif|webp|mp4|webm|mp3|ogg|wav|pdf)$/i.test(u.split('?')[0]))
              .slice(0, 3)
            return urls.length > 0 ? <EmbedCard urls={urls} /> : null
          })()}
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
                ) : canDelete ? (
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
            
            onSelect={(key, type) => {
              handleToggleReaction(key, type)
              setPickerOpen(false)
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {contextMenuPos && (
          <ContextMenu
            x={contextMenuPos.x}
            y={contextMenuPos.y}
            sections={getContextMenuSections()}
            onClose={() => setContextMenuPos(null)}
          />
        )}

        {showProfileCard && message.user_id && (
          <UserProfileCard
            userId={message.user_id}
            anchorEl={profileAnchorRef.current}
            onClose={() => { setShowProfileCard(false); profileAnchorRef.current = null }}
          />
        )}
      </div>
    </div>
  )
}


export default memo(MessageBubble)
