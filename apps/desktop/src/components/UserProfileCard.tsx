import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useServerStore } from '../store/serverStore'
import { getOrCreateDMChannel, getUserProfile } from '@kizuna/shared'
import { MessageCircle, Clock, Calendar } from 'lucide-react'
import { hexToRgba } from '../utils/color'
import type { Member } from '@kizuna/shared'
import './UserProfileCard.css'

interface UserProfileCardProps {
  userId: string
  anchorEl: HTMLElement | null
  onClose: () => void
  onStartDM?: (userId: string) => void
  onMention?: (username: string) => void
}

function formatDate(ts: number | null | undefined): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function UserProfileCard({ userId, anchorEl, onClose, onStartDM, onMention: _onMention }: UserProfileCardProps) {
  const members = useChatStore((s) => s.members)
  const session = useServerStore((s) => s.activeSession)
  const userStatuses = useVoiceStore((s) => s.userStatuses)
  const userActivities = useVoiceStore((s) => s.userActivities)
  const setDMChannels = useChatStore((s) => s.setDMChannels)
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [fullProfile, setFullProfile] = useState<Member | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const member = useMemo(() => members.find((m) => m.id === userId), [members, userId])
  const status = userStatuses[userId] || 'offline'

  useEffect(() => {
    if (!session) return
    getUserProfile(session.url, userId)
      .then(setFullProfile)
      .catch(() => {})
  }, [session, userId])

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

  const profile = fullProfile || member
  const isSelf = member.id === session?.user?.id
  const displayName = member.display_name || member.username
  const joinedAt = formatDate(fullProfile?.joined_at ?? member.joined_at)
  const lastSeenAt = formatDate(fullProfile?.last_seen_at ?? member.last_seen_at)
  const statusText = profile.status_text || null
  const statusEmoji = profile.status_emoji || null
  const statusStickerId = profile.status_sticker_id || null
  const activity = userActivities[userId]

  return createPortal(
    <div ref={ref} className="user-profile-card" style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className="user-profile-card__banner" style={member.banner ? { backgroundImage: `url(${member.banner})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { backgroundColor: member.custom_role_color || (member.role === 'admin' ? 'var(--yellow)' : 'var(--avatar-bg-default)') }} />
      <div className="user-profile-card__avatar-wrap">
        <div className="user-profile-card__avatar" style={{ backgroundColor: member.custom_role_color || (member.role === 'admin' ? 'var(--yellow)' : 'var(--avatar-bg-default)') }}>
          {member.avatar ? (
            <img src={member.avatar} alt="" className="user-profile-card__avatar-img" />
          ) : displayName[0]?.toUpperCase()}
        </div>
        {statusStickerId && session && (
          <img
            src={`${session.url}/api/gifs/${statusStickerId}/thumb`}
            alt=""
            className="user-profile-card__sticker-badge"
            onMouseEnter={(e) => {
              const img = e.currentTarget
              if (img.dataset.thumbFailed !== '1') {
                img.src = `${session.url}/api/gifs/${statusStickerId}/file`
              }
            }}
            onMouseLeave={(e) => {
              const img = e.currentTarget
              if (img.dataset.thumbFailed !== '1') {
                img.src = `${session.url}/api/gifs/${statusStickerId}/thumb`
              }
            }}
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement
              if (img.src.includes('/thumb')) {
                img.dataset.thumbFailed = '1'
                img.src = `${session.url}/api/gifs/${statusStickerId}/file`
                img.onerror = () => { img.style.display = 'none' }
              }
            }}
          />
        )}
        <span className={`user-profile-card__status user-profile-card__status--${status}`} />
      </div>

      <div className="user-profile-card__info">
        <h3 className="user-profile-card__name">{displayName}</h3>
        <p className="user-profile-card__username">@{member.username}</p>
        <p className="user-profile-card__status-text">
          {statusEmoji && !statusStickerId && <span className="user-profile-card__status-emoji">{statusEmoji}</span>}
          {statusText}
        </p>
        {activity && (
          <p className="user-profile-card__activity">
            <span className="user-profile-card__activity-label">
              {activity.type === 'music' ? 'Listening to' : activity.type === 'game' ? 'Playing' : activity.type === 'video' ? 'Watching' : ''}
            </span>
            <span className="user-profile-card__activity-name">{activity.name}</span>
            {activity.details && <span className="user-profile-card__activity-details">{activity.details}</span>}
          </p>
        )}
      </div>

      <div className="user-profile-card__roles">
        {member.custom_roles?.map((r) => (
          <span key={r.id} className="user-profile-card__role-badge" style={{ color: r.color || 'var(--brand)', borderColor: hexToRgba(r.color || '#4c6ef5', 0.4), backgroundColor: hexToRgba(r.color || '#4c6ef5', 34 / 255) }}>
            {r.name}
          </span>
        ))}
      </div>

      <div className="user-profile-card__meta">
        <div className="user-profile-card__meta-item">
          <span className={`user-profile-card__status-dot user-profile-card__status-dot--${status}`} />
          <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
        </div>
        {joinedAt && (
          <div className="user-profile-card__meta-item">
            <Calendar size={12} />
            <span>Member since {joinedAt}</span>
          </div>
        )}
        {lastSeenAt && (
          <div className="user-profile-card__meta-item">
            <Clock size={12} />
            <span>Last online {lastSeenAt}</span>
          </div>
        )}
      </div>

      {!isSelf && (
        <div className="user-profile-card__actions">
          <button className="user-profile-card__action-btn" onClick={handleStartDM}>
            <MessageCircle size={14} />
            Message
          </button>
          <button className="user-profile-card__action-btn" onClick={() => { useChatStore.getState().setPendingMention(member.username); onClose() }}>
            @
            Mention
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
