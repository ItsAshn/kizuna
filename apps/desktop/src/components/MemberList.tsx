import { useState, useEffect, useRef } from 'react'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import UserProfileCard from './UserProfileCard'
import '../styles/member-list.css'

interface Props {
  visible: boolean
}

export default function MemberList({ visible }: Props) {
  const members = useChatStore((s) => s.members)
  const session = useServerStore((s) => s.activeSession)
  const userStatuses = useChatStore((s) => s.userStatuses)
  const [search, setSearch] = useState('')
  const [closing, setClosing] = useState(false)
  const [profileUserId, setProfileUserId] = useState<string | null>(null)
  const profileAnchorRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!visible) {
      setClosing(true)
      const timer = setTimeout(() => setClosing(false), 200)
      return () => clearTimeout(timer)
    }
  }, [visible])

  if (!visible && !closing) return null

  function memberRank(m: typeof members[number]): number {
    if (m.role === 'admin') return 0
    if (m.custom_role_id) return 1
    return 2
  }

  const filtered = (search.trim()
    ? members.filter(m =>
        m.username.toLowerCase().includes(search.toLowerCase()) ||
        m.display_name.toLowerCase().includes(search.toLowerCase()),
      )
    : [...members]
  ).sort((a, b) => {
    const r = memberRank(a) - memberRank(b)
    if (r !== 0) return r
    return a.username.localeCompare(b.username)
  })

  return (
    <div className={`member-list${closing ? ' member-list--closing' : ''}`} role="complementary" aria-label="Members">
      <div className="member-list__header">
        <h3 className="member-list__title">Members — {members.length}</h3>
        <input
          className="member-list__search"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="member-list__body">
        {filtered.length === 0 && (
          <p className="member-list__empty-text">No members found</p>
        )}

        {filtered.map((member) => {
          const status = userStatuses[member.id] || 'offline'
          return (
            <button
              key={member.id}
              onClick={(e) => {
                profileAnchorRef.current = e.currentTarget as HTMLElement
                setProfileUserId(member.id)
              }}
              className="member-list__member"
            >
              <div className="member-list__member-avatar-wrap">
                <div
                  className="member-list__member-avatar"
                  style={{ backgroundColor: member.custom_role_color || (member.role === 'admin' ? '#f59e0b' : '#374151') }}
                >
                  {member.avatar ? (
                    <img src={member.avatar} alt="" className="member-list__member-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  ) : member.display_name?.[0]?.toUpperCase()}
                </div>
                {status !== 'offline' && <span className={`member-list__online-dot member-list__online-dot--${status}`} />}
              </div>
              <div className="member-list__member-info">
                <div className="member-list__member-name">{member.display_name}</div>
                {member.custom_role_name && (
                  <div className="member-list__member-role" style={{ color: member.custom_role_color || undefined }}>
                    {member.custom_role_name}
                  </div>
                )}
              </div>
              {member.role === 'admin' && <span className="member-list__admin-badge">admin</span>}
              {member.id === session?.user.id && <span className="member-list__self-tag">you</span>}
            </button>
          )
        })}
      </div>

      {profileUserId && (
        <UserProfileCard
          userId={profileUserId}
          anchorEl={profileAnchorRef.current}
          onClose={() => { setProfileUserId(null); profileAnchorRef.current = null }}
        />
      )}
    </div>
  )
}
