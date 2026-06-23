import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useVoiceStore } from '../store/voiceStore'
import { useServerStore } from '../store/serverStore'
import { updateStatus } from '@kizuna/shared'
import type { UserStatus } from '@kizuna/shared'
import './UserStatusPicker.css'

interface Props {
  socketRef: React.MutableRefObject<any>
  children: React.ReactNode
}

const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'busy', label: 'Busy' },
  { value: 'invisible', label: 'Invisible' },
]

const STATUS_EMOJI: string[] = ['💬', '🎮', '🎵', '🍿', '💼', '✈️', '🛌', '🏃', '📚', '🛒', '🍔', '💻']

export default function UserStatusPicker({ socketRef, children }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const refreshSessionUser = useServerStore((s) => s.refreshSessionUser)
  const userStatuses = useVoiceStore((s) => s.userStatuses)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [statusText, setStatusText] = useState(session?.user.status_text || '')
  const [statusEmoji, setStatusEmoji] = useState(session?.user.status_emoji || '')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)

  const userId = session?.user.id
  const currentStatus: UserStatus = userId ? (userStatuses[userId] || 'online') : 'online'

  const updateCoords = useCallback(() => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect()
      setCoords({ top: rect.bottom + 4, left: rect.left })
    }
  }, [])

  useEffect(() => {
    if (session?.user) {
      setStatusText(session.user.status_text || '')
      setStatusEmoji(session.user.status_emoji || '')
    }
  }, [session?.user.status_text, session?.user.status_emoji])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowEmojiPicker(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setShowEmojiPicker(false) }
    }
    document.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [])

  function handleToggle() {
    if (!open) updateCoords()
    setOpen(!open)
  }

  function handleSelect(status: UserStatus) {
    setOpen(false)
    if (socketRef.current) {
      socketRef.current.emit('user:status', { status })
    }
  }

  async function handleStatusTextChange(text: string) {
    setStatusText(text)
    if (!session) return
    try {
      await updateStatus(session.url, text || null, statusEmoji || null)
      await refreshSessionUser()
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  async function handleStatusEmojiChange(emoji: string) {
    const newEmoji = statusEmoji === emoji ? '' : emoji
    setStatusEmoji(newEmoji)
    setShowEmojiPicker(false)
    if (!session) return
    try {
      await updateStatus(session.url, statusText || null, newEmoji || null)
      await refreshSessionUser()
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  const hasCustomStatus = statusText || statusEmoji

  return (
    <div
      ref={wrapperRef}
      className={`status-picker status-picker--${currentStatus}`}
      onClick={handleToggle}
      title={hasCustomStatus ? `${statusEmoji ? statusEmoji + ' ' : ''}${statusText}` : currentStatus}
    >
      {children}
      {open && createPortal(
        <div className="status-picker__dropdown" style={{ top: coords.top, left: coords.left, position: 'fixed' }}>
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`status-picker__option${currentStatus === opt.value ? ' status-picker__option--active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleSelect(opt.value) }}
            >
              <span className={`status-picker__dot status-picker__dot--${opt.value}`} />
              {opt.label}
            </button>
          ))}
          <div className="status-picker__divider" />
          <div className="status-picker__custom">
            <div className="status-picker__custom-row">
              <button
                className="status-picker__emoji-btn"
                onClick={(e) => { e.stopPropagation(); setShowEmojiPicker(!showEmojiPicker) }}
                title="Pick emoji"
              >
                {statusEmoji || '😊'}
              </button>
              <input
                className="status-picker__text-input"
                placeholder="Set a custom status..."
                value={statusText}
                maxLength={128}
                onChange={(e) => setStatusText(e.target.value)}
                onBlur={() => { if (statusText !== (session?.user.status_text || '')) handleStatusTextChange(statusText) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() } }}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            {showEmojiPicker && (
              <div className="status-picker__emoji-grid">
                {STATUS_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    className={`status-picker__emoji-option${statusEmoji === emoji ? ' status-picker__emoji-option--active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleStatusEmojiChange(emoji) }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            {statusText && (
              <button
                className="status-picker__save-btn"
                onClick={(e) => { e.stopPropagation(); handleStatusTextChange(statusText) }}
              >
                Save
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
