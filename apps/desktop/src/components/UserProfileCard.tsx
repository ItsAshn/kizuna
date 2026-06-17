import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useServerStore } from '../store/serverStore'
import { getOrCreateDMChannel } from '@kizuna/shared'
import { MessageCircle } from 'lucide-react'
import { hexToRgba } from '../utils/color'
import '../styles/user-profile-card.css'

interface UserProfileCardProps {
  userId: string
  anchorEl: HTMLElement | null
  onClose: () => void
  onStartDM?: (userId: string) => void
  onMention?: (username: string) => void
}

export default function UserProfileCard({ userId, anchorEl, onClose, onStartDM, onMention }: UserProfileCardProps) {
  const members = useChatStore((s) => s.members)
  const session = useServerStore((s) => s.activeSession)
  const userStatuses = useVoiceStore((s) => s.userStatuses)
  const setDMChannels = useChatStore((s) => s.setDMChannels)
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const member = useMemo(() => members.find((m) => m.id === userId), [members, userId])
  const status = userStatuses[userId] || 'offline'

  useEffect(() => {
    const el = ref.current
    if (!el || !anchorEl) return
    const anchorRect = anchorEl.getBoundingClientRect()
    const cardRect = el.getBoundingClientRect()

    let top = anchorRect.bottom + 8
    let left = anchorRect.left + anchorRect.width / 2 - cardRect.width / 2

    if (left + cardRect.width > window.innerWidth - 16) {
      left = window.innerWidth - cardRect.width - 16
    }
    if (left < 16) left = 16
    if (top + cardRect.height > window.innerHeight - 16) {
      top = anchorRect.top - cardRect.height - 8
    }

    setPos({ top, left })
  }, [anchorEl])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleStartDM = async () => {
    if (!session || !member) return
    try {
      const dm = await getOrCreateDMChannel(session.url, member.id)
      setDMChannels([dm, ...useChatStore.getState().dmChannels.filter((d) => d.id !== dm.id)])
      setActiveDMChannel(dm.id)
      onStartDM?.(member.id)
    } catch {}
    onClose()
  }

  if (!member) return null

  const isSelf = member.id === session?.user?.id
  const displayName = member.display_name || member.username

  return createPortal(
    <div ref={ref} className="user-profile-card" style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className="user-profile-card__banner" style={member.banner ? { backgroundImage: `url(${member.banner})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { backgroundColor: member.custom_role_color || (member.role === 'admin' ? 'var(--yellow)' : 'var(--avatar-bg-default)') }} />
      <div className="user-profile-card__avatar-wrap">
        <div className="user-profile-card__avatar" style={{ backgroundColor: member.custom_role_color || (member.role === 'admin' ? 'var(--yellow)' : 'var(--avatar-bg-default)') }}>
          {member.avatar ? (
            <img src={member.avatar} alt="" className="user-profile-card__avatar-img" />
          ) : displayName[0]?.toUpperCase()}
        </div>
        <span className={`user-profile-card__status user-profile-card__status--${status}`} />
      </div>

      <div className="user-profile-card__info">
        <h3 className="user-profile-card__name">{displayName}</h3>
        <p className="user-profile-card__username">@{member.username}</p>
      </div>

      <div className="user-profile-card__roles">
        {member.custom_roles?.map((r) => (
          <span key={r.id} className="user-profile-card__role-badge" style={{ color: r.color || '#4c6ef5', borderColor: hexToRgba(r.color || '#4c6ef5', 0.4), backgroundColor: hexToRgba(r.color || '#4c6ef5', 34 / 255) }}>
            {r.name}
          </span>
        ))}
      </div>

      <div className="user-profile-card__meta">
        <div className="user-profile-card__meta-item">
          <span className={`user-profile-card__status-dot user-profile-card__status-dot--${status}`} />
          <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
        </div>
      </div>

      {!isSelf && (
        <div className="user-profile-card__actions">
          <button className="user-profile-card__action-btn" onClick={handleStartDM}>
            <MessageCircle size={14} />
            Message
          </button>
          <button className="user-profile-card__action-btn" onClick={() => { onMention?.(member.username); onClose() }}>
            @
            Mention
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
