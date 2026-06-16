import { useState, useEffect, useRef, useMemo } from 'react'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import type { Member, CustomRole } from '@kizuna/shared'
import UserProfileCard from './UserProfileCard'
import '../styles/member-list.css'

interface Props {
  visible: boolean
}

interface HoistGroup {
  role: CustomRole
  members: Member[]
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

  function memberRank(m: Member): number {
    if (m.role === 'admin') return -10000
    const highestPos = m.custom_roles?.reduce((max, r) => Math.max(max, r.position ?? 0), 0) ?? 0
    return -highestPos
  }

  const hoistGroups = useMemo(() => {
    const groups: HoistGroup[] = []
    const seenRoleIds = new Set<string>()

    const hoistedRoles = new Map<string, CustomRole>()
    for (const m of members) {
      for (const r of m.custom_roles || []) {
        if (r.hoist && !hoistedRoles.has(r.id)) {
          hoistedRoles.set(r.id, r)
        }
      }
    }

    const sortedHoistRoles = [...hoistedRoles.values()].sort((a, b) => (b.position ?? 0) - (a.position ?? 0))

    for (const role of sortedHoistRoles) {
      const groupMembers = members.filter(m => {
        const memberHoistedRole = (m.custom_roles || []).filter(r => r.hoist).sort((a, b) => (b.position ?? 0) - (a.position ?? 0))[0]
        return memberHoistedRole?.id === role.id
      })

      groupMembers.sort((a, b) => {
        const r = memberRank(a) - memberRank(b)
        if (r !== 0) return r
        return (a.display_name || a.username).localeCompare(b.display_name || b.username)
      })

      seenRoleIds.add(role.id)
      if (groupMembers.length > 0) {
        groups.push({ role, members: groupMembers })
      }
    }

    return groups
  }, [members])

  const ungroupedMembers = useMemo(() => {
    const hoistedRoleIds = new Set(hoistGroups.flatMap(g => g.members.map(m => m.id)))
    return members
      .filter(m => !hoistedRoleIds.has(m.id))
      .sort((a, b) => {
        const r = memberRank(a) - memberRank(b)
        if (r !== 0) return r
        return (a.display_name || a.username).localeCompare(b.display_name || b.username)
      })
  }, [members, hoistGroups])

  const filteredMembers = search.trim()
    ? members.filter(m =>
        m.username.toLowerCase().includes(search.toLowerCase()) ||
        m.display_name.toLowerCase().includes(search.toLowerCase()),
      ).sort((a, b) => {
        const r = memberRank(a) - memberRank(b)
        if (r !== 0) return r
        return a.username.localeCompare(b.username)
      })
    : []

  const isSearching = search.trim().length > 0

  function onlineCount(mems: Member[]): number {
    return mems.filter(m => userStatuses[m.id] && userStatuses[m.id] !== 'offline').length
  }

  function renderMember(member: Member) {
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
            ) : (member.display_name || member.username)[0]?.toUpperCase()}
          </div>
          {status !== 'offline' && <span className={`member-list__online-dot member-list__online-dot--${status}`} />}
        </div>
        <div className="member-list__member-info">
          <div className="member-list__member-name">{member.display_name || member.username}</div>
          {member.custom_role_name && (
            <div className="member-list__member-role" style={{ color: member.custom_role_color || undefined }}>
              {member.custom_role_name}
            </div>
          )}
        </div>
        {member.role === 'admin' && !member.custom_role_name && <span className="member-list__admin-badge">admin</span>}
        {member.is_host && <span className="member-list__host-badge">host</span>}
        {member.id === session?.user.id && <span className="member-list__self-tag">you</span>}
      </button>
    )
  }

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
        {isSearching ? (
          filteredMembers.length === 0 ? (
            <p className="member-list__empty-text">No members found</p>
          ) : (
            filteredMembers.map(renderMember)
          )
        ) : (
          <>
            {hoistGroups.map(group => (
              <div key={group.role.id} className="member-list__group">
                <div className="member-list__group-header">
                  <span className="member-list__group-dot" style={{ backgroundColor: group.role.color }} />
                  <span className="member-list__group-name" style={{ color: group.role.color }}>{group.role.name}</span>
                  <span className="member-list__group-count">{group.members.length}</span>
                  {onlineCount(group.members) > 0 && (
                    <span className="member-list__group-online">{onlineCount(group.members)} online</span>
                  )}
                </div>
                {group.members.map(renderMember)}
              </div>
            ))}
            {ungroupedMembers.length > 0 && (
              <div className="member-list__group">
                {hoistGroups.length > 0 && (
                  <div className="member-list__group-header">
                    <span className="member-list__group-name" style={{ color: 'var(--text-muted)' }}>members</span>
                    <span className="member-list__group-count">{ungroupedMembers.length}</span>
                    {onlineCount(ungroupedMembers) > 0 && (
                      <span className="member-list__group-online">{onlineCount(ungroupedMembers)} online</span>
                    )}
                  </div>
                )}
                {ungroupedMembers.map(renderMember)}
              </div>
            )}
          </>
        )}
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
