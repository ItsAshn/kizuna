import { useState, useRef, useEffect, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import { createPortal } from 'react-dom'
import { Sticker } from 'lucide-react'
import { useVoiceStore } from '../store/voiceStore'
import { useServerStore } from '../store/serverStore'
import { updateStatus, fetchGifs, fetchStickerPacks } from '@kizuna/shared'
import type { UserStatus, GifInfo } from '@kizuna/shared'
import './UserStatusPicker.css'

interface Props {
  socketRef: React.MutableRefObject<Socket | null>
  children: React.ReactNode
}

const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'busy', label: 'Busy' },
  { value: 'invisible', label: 'Invisible' },
]

export default function UserStatusPicker({ socketRef, children }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const refreshSessionUser = useServerStore((s) => s.refreshSessionUser)
  const userStatuses = useVoiceStore((s) => s.userStatuses)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [statusText, setStatusText] = useState(session?.user?.status_text || '')
  const [statusStickerId, setStatusStickerId] = useState(session?.user?.status_sticker_id || '')
  const [showStickerPicker, setShowStickerPicker] = useState(false)

  const [stickerPacks, setStickerPacks] = useState<string[]>([])
  const [activePack, setActivePack] = useState('')
  const [stickers, setStickers] = useState<GifInfo[]>([])
  const [loadingStickers, setLoadingStickers] = useState(false)

  const userId = session?.user?.id
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
      setStatusStickerId(session.user.status_sticker_id || '')
    }
  }, [session?.user?.status_text, session?.user?.status_sticker_id])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowStickerPicker(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); setShowStickerPicker(false) }
    }
    document.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [])

  const loadStickerPacks = useCallback(async () => {
    if (!session) return
    try {
      const packs = await fetchStickerPacks(session.url)
      setStickerPacks(packs)
      if (packs.length > 0 && !activePack) setActivePack(packs[0])
    } catch { /* ignore */ }
  }, [session, activePack])

  useEffect(() => {
    if (showStickerPicker && stickerPacks.length === 0) {
      loadStickerPacks()
    }
  }, [showStickerPicker, stickerPacks.length, loadStickerPacks])

  useEffect(() => {
    if (showStickerPicker && activePack && session) {
      setLoadingStickers(true)
      fetchGifs(session.url, { type: 'sticker', pack: activePack, limit: 50 })
        .then(setStickers)
        .catch(() => setStickers([]))
        .finally(() => setLoadingStickers(false))
    }
  }, [showStickerPicker, activePack, session])

  function handleToggle() {
    if (!open) updateCoords()
    setOpen(!open)
    if (!open) setShowStickerPicker(false)
  }

  function handleSelect(status: UserStatus) {
    setOpen(false)
    if (socketRef.current) {
      socketRef.current.emit('user:status', { status })
    }
  }

  function handleStickerSelect(stickerId: string) {
    const newId = statusStickerId === stickerId ? '' : stickerId
    setStatusStickerId(newId)
    setShowStickerPicker(false)
  }

  async function handleSave() {
    if (!session) return
    try {
      await updateStatus(session.url, statusText || null, null, statusStickerId || null)
      await refreshSessionUser()
      setOpen(false)
    } catch (err) {
      console.error('Failed to update status:', err)
    }
  }

  const hasCustomStatus = statusText || statusStickerId
  const isDirty = statusText !== (session?.user?.status_text || '') || statusStickerId !== (session?.user?.status_sticker_id || '')

  return (
    <div
      ref={wrapperRef}
      className={`status-picker status-picker--${currentStatus}${statusStickerId ? ' status-picker--has-sticker' : ''}`}
      onClick={handleToggle}
      title={hasCustomStatus ? `Sticker + ${statusText || ''}` : currentStatus}
    >
      {/* The sticker badge is rendered by the Avatar child (ui/Avatar). */}
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
                className={`status-picker__sticker-btn${statusStickerId ? ' status-picker__sticker-btn--has' : ''}`}
                onClick={(e) => { e.stopPropagation(); setShowStickerPicker(!showStickerPicker) }}
                title="Pick sticker"
              >
                {statusStickerId && session ? (
                  <img
                    src={`${session.url}/api/gifs/${statusStickerId}/file`}
                    alt=""
                    className="status-picker__sticker-thumb"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <Sticker size={14} />
                )}
              </button>
              <input
                className="status-picker__text-input"
                placeholder="Set a custom status..."
                value={statusText}
                maxLength={128}
                onChange={(e) => setStatusText(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            {showStickerPicker && (
              <div className="status-picker__sticker-panel">
                {stickerPacks.length > 0 && (
                  <div className="status-picker__packs">
                    {stickerPacks.map(pack => (
                      <button
                        key={pack}
                        className={`status-picker__pack-btn${activePack === pack ? ' status-picker__pack-btn--active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setActivePack(pack) }}
                      >
                        {pack}
                      </button>
                    ))}
                  </div>
                )}
                <div className="status-picker__sticker-grid">
                  {loadingStickers && <div className="status-picker__sticker-status">Loading...</div>}
                  {!loadingStickers && stickers.length === 0 && (
                    <div className="status-picker__sticker-status">No stickers in this pack</div>
                  )}
                  {!loadingStickers && stickers.map(s => {
                    const url = s.file_url.startsWith('/') ? `${session?.url}${s.file_url}` : s.file_url
                    return (
                      <button
                        key={s.id}
                        className={`status-picker__sticker-option${statusStickerId === s.id ? ' status-picker__sticker-option--active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); handleStickerSelect(s.id) }}
                        title={s.display_name}
                      >
                        <img src={url} alt={s.display_name} className="status-picker__sticker-img" loading="lazy" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {isDirty && (
              <button
                className="status-picker__save-btn"
                onClick={(e) => { e.stopPropagation(); handleSave() }}
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
