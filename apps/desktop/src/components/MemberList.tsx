import { useState, useEffect, useRef, useMemo } from 'react'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useServerStore } from '../store/serverStore'
import { useMobile, useTablet } from '../hooks/useMobile'
import type { Member, CustomRole } from '@kizuna/shared'
import { X } from 'lucide-react'
import { ActivityIcon, activitySummary } from '../utils/activity'
import UserProfileCard from './UserProfileCard'
import Skeleton from './Skeleton'
import IconButton from './ui/IconButton'
import { Avatar } from './ui'
import './MemberList.css'

interface Props {
  visible: boolean
  onClose?: () => void
}

interface HoistGroup {
  role: CustomRole
  members: Member[]
}

export default function MemberList({ visible, onClose }: Props) {
  const members = useChatStore((s) => s.members)
  const session = useServerStore((s) => s.activeSession)
  const isMobile = useMobile()
  const isTablet = useTablet()
  // On phone and tablet the list is an overlay drawer that needs its own close affordance.
  const isOverlay = isMobile || isTablet
  const userStatuses = useVoiceStore((s) => s.userStatuses)
  const userActivities = useVoiceStore((s) => s.userActivities)
  const [search, setSearch] = useState('')
  const [closing, setClosing] = useState(false)
  const [profileUserId, setProfileUserId] = useState<string | null>(null)
  const profileAnchorRef = useRef<HTMLElement | null>(null)
  const prevVisible = useRef(visible)
  const [hasLoaded, setHasLoaded] = useState(false)

  useEffect(() => {
    if (members.length > 0) setHasLoaded(true)
  }, [members.length])

  if (prevVisible.current !== visible) {
    if (!visible) {
      setClosing(true)
    } else {
      setClosing(false)
    }
    prevVisible.current = visible
  }

  useEffect(() => {
    if (!visible) {
      const timer = setTimeout(() => setClosing(false), 200)
      return () => clearTimeout(timer)
    }
  }, [visible])

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

  if (!visible && !closing) return null

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

  function isOnline(m: Member): boolean {
    return userStatuses[m.id] != null && userStatuses[m.id] !== 'offline' && userStatuses[m.id] !== 'invisible'
  }

  function onlineCount(mems: Member[]): number {
    return mems.filter(m => isOnline(m)).length
  }

  function renderMember(member: Member) {
    const status = userStatuses[member.id] || 'offline'
    const activity = userActivities[member.id]
    const offline = !isOnline(member)
    const stickerId = member.status_sticker_id
    return (
      <button
        key={member.id}
        onClick={(e) => {
          profileAnchorRef.current = e.currentTarget as HTMLElement
          setProfileUserId(member.id)
        }}
        className={`member-list__member${offline ? ' member-list__member--offline' : ''}`}
      >
        <Avatar
          src={member.avatar}
          name={member.display_name || member.username}
          size={32}
          status={offline ? undefined : status}
          stickerId={stickerId}
          serverUrl={session?.url}
          bgColor={member.custom_role_color || (member.role === 'admin' ? 'var(--yellow)' : 'var(--avatar-bg-default)')}
        />
        <div className="member-list__member-info">
          <div className="member-list__member-name">{member.display_name || member.username}</div>
          {activity ? (
            <div className="member-list__member-activity" title={activitySummary(activity)}>
              <span className={`member-list__member-activity-icon${activity.icon ? ' member-list__member-activity-icon--img' : ''}`}>
                <ActivityIcon activity={activity} size={11} className="member-list__member-activity-img" />
              </span>
              <span className="member-list__member-activity-text">{activity.name}</span>
            </div>
          ) : null}
        </div>
        {member.is_host && <span className="member-list__host-badge">host</span>}
        {member.id === session?.user.id && <span className="member-list__self-tag">you</span>}
      </button>
    )
  }

  function renderSection(predicate: (m: Member) => boolean) {
    return (
      <>
        {hoistGroups.map(group => {
          const filtered = group.members.filter(predicate)
          if (filtered.length === 0) return null
          return (
            <div key={group.role.id} className="member-list__group">
              <div className="member-list__group-header">
                <span className="member-list__group-dot" style={{ backgroundColor: group.role.color }} />
                <span className="member-list__group-name" style={{ color: group.role.color }}>{group.role.name}</span>
                <span className="member-list__group-count">{onlineCount(group.members)}/{group.members.length}</span>
              </div>
              {filtered.map(renderMember)}
            </div>
          )
        })}
        {(() => {
          const filtered = ungroupedMembers.filter(predicate)
          if (filtered.length === 0) return null
          return (
            <div className="member-list__group">
              {hoistGroups.length > 0 && (
                <div className="member-list__group-header">
                  <span className="member-list__group-name" style={{ color: 'var(--text-muted)' }}>members</span>
                  <span className="member-list__group-count">{onlineCount(ungroupedMembers)}/{ungroupedMembers.length}</span>
                </div>
              )}
              {filtered.map(renderMember)}
            </div>
          )
        })()}
      </>
    )
  }

  return (
    <div className={`member-list${closing ? ' member-list--closing' : ''}`} role="complementary" aria-label="Members">
      {isOverlay && <div className="member-list__drag-handle" />}
      <div className="member-list__header">
        <h3 className="member-list__title">Members — {onlineCount(members)}/{members.length}</h3>
        {isOverlay && onClose && (
          <IconButton
            icon={<X size={20} />}
            label="Close member list"
            size="lg"
            onClick={onClose}
          />
        )}
        <input
          className="member-list__search"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="member-list__body">
        {!hasLoaded && members.length === 0 ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton--member">
              <Skeleton variant="circle" width={32} height={32} />
              <Skeleton variant="text" width={`${60 + (i % 3) * 15}%`} />
            </div>
          ))
        ) : isSearching ? (
          filteredMembers.length === 0 ? (
            <p className="member-list__empty-text">No members found</p>
          ) : (
            filteredMembers.map(renderMember)
          )
        ) : (
          <>
            {renderSection(m => isOnline(m))}
            {(() => {
              const offlineTotal = members.filter(m => !isOnline(m)).length
              const onlineTotal = members.filter(m => isOnline(m)).length
              if (offlineTotal > 0 && onlineTotal > 0) {
                return <div className="member-list__offline-divider"><span>offline — {offlineTotal}</span></div>
              }
              return null
            })()}
            {renderSection(m => !isOnline(m))}
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
