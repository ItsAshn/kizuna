import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import {
  fetchMembers,
  fetchRoles,
  setMemberRole,
  kickMember,
  generatePasswordReset,
  addMemberRole,
  removeMemberRole,
} from '@kizuna/shared'
import type { Member, CustomRole, UserStatus } from '@kizuna/shared'
import { useServerStore } from '../../store/serverStore'
import { useChatStore } from '../../store/chatStore'
import { useVoiceStore } from '../../store/voiceStore'
import { hexToRgba } from '../../utils/color'
import { handleApiErr, useMountedRef } from './common'
import './MembersSection.css'

export function MembersSection({ serverUrl }: { serverUrl: string | undefined }) {
  const mountedRef = useMountedRef()
  const session = useServerStore((s) => s.activeSession)
  const { members, setMembers } = useChatStore()
  const { userStatuses } = useVoiceStore()

  const [membersLoading, setMembersLoading] = useState(false)
  const [memberMsg, setMemberMsg] = useState<Record<string, string>>({})
  const [resetTokenData, setResetTokenData] = useState<{ userId: string; token: string; username: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set())
  const [openOverflowMember, setOpenOverflowMember] = useState<string | null>(null)
  const [kickConfirmMember, setKickConfirmMember] = useState<string | null>(null)
  const [selfDemoteConfirm, setSelfDemoteConfirm] = useState(false)
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [assigningRole, setAssigningRole] = useState<Record<string, boolean>>({})
  const overflowRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!serverUrl) return
    setMembersLoading(true)
    fetchMembers(serverUrl).then(d => { if (mountedRef.current) setMembers(d) }).catch(console.error).finally(() => { if (mountedRef.current) setMembersLoading(false) })
    fetchRoles(serverUrl).then(r => { if (mountedRef.current) setRoles(r) }).catch(err => console.error('Failed to fetch roles:', err))
  }, [serverUrl])

  // close overflow menu on outside click
  useEffect(() => {
    if (!openOverflowMember) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (overflowRef.current && !overflowRef.current.contains(target)) {
        setOpenOverflowMember(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openOverflowMember])

  const toggleMemberSelect = (memberId: string) => {
    setSelectedMembers(prev => {
      const next = new Set(prev)
      if (next.has(memberId)) next.delete(memberId)
      else next.add(memberId)
      return next
    })
  }

  const clearSelection = () => setSelectedMembers(new Set())

  const handleToggleRole = async (m: Member) => {
    if (!serverUrl) return
    const newRole = m.role === 'admin' ? 'member' : 'admin'

    if (newRole === 'member' && m.id === session?.user?.id && !selfDemoteConfirm) {
      setSelfDemoteConfirm(true)
      return
    }
    setSelfDemoteConfirm(false)

    try {
      await setMemberRole(serverUrl, m.id, newRole)
      setMemberMsg(prev => ({ ...prev, [m.id]: `role → ${newRole}` }))
      setTimeout(() => setMemberMsg(prev => { const n = { ...prev }; delete n[m.id]; return n }), 2000)
    } catch (err) {
      setMemberMsg(prev => ({ ...prev, [m.id]: handleApiErr(err) }))
    }
  }

  const handleKick = async (m: Member) => {
    if (!serverUrl) return
    try {
      await kickMember(serverUrl, m.id)
      setMembers(members.filter(mb => mb.id !== m.id))
      setKickConfirmMember(null)
    } catch (err) {
      setMemberMsg(prev => ({ ...prev, [m.id]: handleApiErr(err) }))
    }
  }

  const handleGenerateReset = async (m: Member) => {
    if (!serverUrl) return
    try {
      const result = await generatePasswordReset(serverUrl, m.id)
      setResetTokenData({ userId: m.id, token: result.resetToken, username: result.username })
    } catch (err) {
      setMemberMsg(prev => ({ ...prev, [m.id]: handleApiErr(err) }))
    }
  }

  const handleAddRole = async (userId: string, roleId: string) => {
    if (!serverUrl) return
    setAssigningRole(prev => ({ ...prev, [userId + roleId]: true }))
    try {
      await addMemberRole(serverUrl, userId, roleId)
    } catch (err) {
      console.error('Failed to add member role:', err)
      setMemberMsg(prev => ({ ...prev, [userId]: handleApiErr(err) }))
    }
    setAssigningRole(prev => ({ ...prev, [userId + roleId]: false }))
  }

  const handleRemoveRole = async (userId: string, roleId: string) => {
    if (!serverUrl) return
    setAssigningRole(prev => ({ ...prev, [userId + roleId]: true }))
    try {
      await removeMemberRole(serverUrl, userId, roleId)
    } catch (err) {
      console.error('Failed to remove member role:', err)
      setMemberMsg(prev => ({ ...prev, [userId]: handleApiErr(err) }))
    }
    setAssigningRole(prev => ({ ...prev, [userId + roleId]: false }))
  }

  const handleBulkToggleAdmin = async (makeAdmin: boolean) => {
    if (!serverUrl) return
    const targetRole = makeAdmin ? 'admin' : 'member' as const
    const targets = members.filter(m => selectedMembers.has(m.id) && m.role !== targetRole)

    if (!makeAdmin && targets.some(m => m.id === session?.user?.id) && !selfDemoteConfirm) {
      setSelfDemoteConfirm(true)
      return
    }
    setSelfDemoteConfirm(false)

    for (const m of targets) {
      try {
        await setMemberRole(serverUrl, m.id, targetRole)
      } catch (err) {
        console.error('Bulk toggle admin failed for member:', m.id, err)
      }
    }
    clearSelection()
  }

  const handleBulkKick = async () => {
    if (!serverUrl) return
    const targets = members.filter(m => selectedMembers.has(m.id) && m.id !== session?.user?.id)
    const kickedIds = new Set<string>()
    for (const m of targets) {
      try {
        await kickMember(serverUrl, m.id)
        kickedIds.add(m.id)
      } catch (err) {
        console.error('Bulk kick failed for member:', m.id, err)
      }
    }
    if (kickedIds.size > 0) {
      setMembers(members.filter(m => !kickedIds.has(m.id)))
    }
    clearSelection()
  }

  const handleBulkAddRole = async (roleId: string) => {
    if (!roleId || !serverUrl) return
    const targets = members.filter(m =>
      selectedMembers.has(m.id) &&
      !(m.custom_roles || []).some(r => r.id === roleId),
    )
    for (const m of targets) {
      try {
        await addMemberRole(serverUrl, m.id, roleId)
      } catch (err) {
        console.error('Bulk add role failed for member:', m.id, err)
      }
    }
    clearSelection()
  }

  const filteredMembers = (searchQuery.trim()
    ? members.filter(m =>
        m.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.display_name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : [...members]
  ).sort((a, b) => {
    const rankA = a.role === 'admin' ? 0 : (a.custom_roles || []).length > 0 ? 1 : 2
    const rankB = b.role === 'admin' ? 0 : (b.custom_roles || []).length > 0 ? 1 : 2
    const r = rankA - rankB
    if (r !== 0) return r
    return a.username.localeCompare(b.username)
  })

  const statusFor = (memberId: string): UserStatus => userStatuses[memberId] || 'offline'

  return (
    <div className="server-menu__section">
      <input
        className="server-menu__member-search"
        placeholder={`Search members (${filteredMembers.length})...`}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      {/* Bulk action bar */}
      {selectedMembers.size > 0 && (
        <div className="server-menu__bulk-bar">
          <span className="server-menu__bulk-bar-count">{selectedMembers.size} selected</span>
          <div className="server-menu__bulk-bar-actions">
            <button onClick={() => handleBulkToggleAdmin(true)} className="server-menu__bulk-bar-btn">make admin</button>
            <button onClick={() => handleBulkToggleAdmin(false)} className="server-menu__bulk-bar-btn">remove admin</button>
            <button onClick={handleBulkKick} className="server-menu__bulk-bar-btn server-menu__bulk-bar-btn--danger">kick</button>
            {roles.length > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) handleBulkAddRole(e.target.value); e.target.value = '' }}
                className="server-menu__bulk-bar-btn"
                style={{ background: 'var(--bg-hover)', cursor: 'pointer', appearance: 'auto' } as React.CSSProperties}
              >
                <option value="">+ role</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
          </div>
          <button onClick={clearSelection} className="server-menu__confirm-cancel" style={{ marginLeft: 'auto' }}>clear</button>
        </div>
      )}
      {selfDemoteConfirm && selectedMembers.size > 0 && selectedMembers.has(session?.user?.id ?? '') && (
        <div className="server-menu__self-warn" style={{ marginBottom: '12px' }}>
          <p>This action will remove admin privileges from your own account. Are you sure?</p>
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            <button onClick={() => handleBulkToggleAdmin(false)} className="server-menu__confirm-btn">
              confirm demotion
            </button>
            <button onClick={() => setSelfDemoteConfirm(false)} className="server-menu__confirm-cancel">
              cancel
            </button>
          </div>
        </div>
      )}

      {membersLoading ? (
        <p className="server-menu__loading">loading...</p>
      ) : filteredMembers.length === 0 ? (
        <p className="server-menu__loading">{searchQuery ? 'no members found' : 'no members'}</p>
      ) : (
        filteredMembers.map(m => {
          const isSelf = m.id === session?.user?.id
          const status = statusFor(m.id)
          const isSelected = selectedMembers.has(m.id)
          return (
            <div key={m.id}>
              <div className={`server-menu__member${isSelected ? ' server-menu__member--selected' : ''}`}>
                <label className="server-menu__member-checkbox">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => { if (!m.is_host) toggleMemberSelect(m.id) }}
                    disabled={m.is_host}
                  />
                  <span className="server-menu__member-checkbox-visual" />
                </label>
                <div className="server-menu__member-avatar-wrap">
                  <div className="server-menu__member-avatar">
                    <span>{(m.display_name || m.username)[0]?.toUpperCase()}</span>
                    {m.avatar && <img src={m.avatar} alt="" className="server-menu__member-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
                  </div>
                  {status !== 'offline' && <span className={`server-menu__status-dot server-menu__status-dot--${status}`} />}
                </div>
                <div className="server-menu__member-info">
                  <p className="server-menu__member-name">
                    {m.display_name || m.username}
                    {isSelf && <span className="server-menu__member-self">(you)</span>}
                    {m.is_host && <span className="server-menu__member-badge" style={{ color: '#fab005', borderColor: hexToRgba('#fab005', 0.4), backgroundColor: hexToRgba('#fab005', 34 / 255), marginLeft: '4px' }}>host</span>}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    {(m.custom_roles || []).map((r) => (
                      <span key={r.id} className="server-menu__member-badge"
                        style={{ color: r.color || '#4c6ef5', borderColor: hexToRgba(r.color || '#4c6ef5', 0.4), backgroundColor: hexToRgba(r.color || '#4c6ef5', 34 / 255) }}>
                        {r.name}
                        {!(m.is_host && r.id === 'admin-role') && (
                        <button
                          onClick={() => handleRemoveRole(m.id, r.id)}
                          disabled={assigningRole[m.id + r.id]}
                          className="server-menu__role-remove-btn"
                          title={`Remove ${r.name} role`}
                        >
                          x
                        </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
                {memberMsg[m.id] && <span className="server-menu__member-msg">{memberMsg[m.id]}</span>}
                {m.reset_requested_at && (
                  <span className="server-menu__member-badge" style={{ color: '#fbbf24', borderColor: hexToRgba('#fbbf24', 0.4), backgroundColor: hexToRgba('#fbbf24', 34 / 255) }}>
                    reset
                  </span>
                )}
                <div className="server-menu__member-overflow-wrap" ref={openOverflowMember === m.id ? overflowRef : undefined}>
                  <button
                    onClick={() => {
                      if (openOverflowMember === m.id) {
                        setOpenOverflowMember(null)
                        setSelfDemoteConfirm(false)
                      } else {
                        setOpenOverflowMember(m.id)
                        setSelfDemoteConfirm(false)
                      }
                    }}
                    className={`server-menu__member-overflow-btn${openOverflowMember === m.id ? ' server-menu__member-overflow-btn--active' : ''}`}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {openOverflowMember === m.id && (
                    <div className="server-menu__overflow-menu">
                      {!m.is_host && (isSelf && selfDemoteConfirm && m.role === 'admin' ? (
                        <button
                          onClick={() => { setOpenOverflowMember(null); handleToggleRole(m) }}
                          className="server-menu__overflow-item server-menu__overflow-item--danger">
                          confirm demotion
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            if (isSelf && m.role === 'admin') {
                              setSelfDemoteConfirm(true)
                            } else {
                              setOpenOverflowMember(null)
                              handleToggleRole(m)
                            }
                          }}
                          className="server-menu__overflow-item">
                          {m.role === 'admin' ? 'remove admin' : 'make admin'}
                        </button>
                      ))}
                      <button
                        onClick={() => { setOpenOverflowMember(null); handleGenerateReset(m) }}
                        className="server-menu__overflow-item">
                        reset password
                      </button>
                      {!isSelf && !m.is_host && (
                        <button
                          onClick={() => { setOpenOverflowMember(null); setKickConfirmMember(m.id) }}
                          className="server-menu__overflow-item server-menu__overflow-item--danger">
                          kick
                        </button>
                      )}
                      {roles.length > 0 && (
                        <>
                          <div className="server-menu__overflow-divider" />
                          <span className="server-menu__overflow-section-title">assign roles</span>
                          {roles.map(r => {
                            const hasRole = (m.custom_roles || []).some(cr => cr.id === r.id)
                            return (
                              <button
                                key={r.id}
                                onClick={() => {
                                  if (hasRole) handleRemoveRole(m.id, r.id)
                                  else handleAddRole(m.id, r.id)
                                  if (!assigningRole[m.id + r.id]) setOpenOverflowMember(null)
                                }}
                                disabled={assigningRole[m.id + r.id]}
                                className="server-menu__overflow-role-item"
                              >
                                <span className="server-menu__overflow-role-dot" style={{ backgroundColor: r.color }} />
                                {r.name}
                                {hasRole && <span className="server-menu__overflow-role-check">&#10003;</span>}
                              </button>
                            )
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Kick confirmation panel */}
              {kickConfirmMember === m.id && (
                <div className="server-menu__confirm-panel">
                  <p className="server-menu__confirm-text">
                    Kick {m.display_name || m.username}? They can rejoin via invite.
                  </p>
                  <div className="server-menu__confirm-actions">
                    <button onClick={() => handleKick(m)} className="server-menu__confirm-btn">kick</button>
                    <button onClick={() => setKickConfirmMember(null)} className="server-menu__confirm-cancel">cancel</button>
                  </div>
                </div>
              )}

              {/* Reset token panel */}
              {resetTokenData?.userId === m.id && (
                <div style={{ marginTop: '6px', padding: '6px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)', fontSize: '10px' }}>
                  <p style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Reset token for {resetTokenData.username} (valid 24h) — share this with the user:</p>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <code style={{ flex: 1, fontSize: '10px', color: 'var(--accent-color)', wordBreak: 'break-all', background: 'var(--bg-primary)', padding: '4px 6px', borderRadius: '4px' }}>{resetTokenData.token}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(resetTokenData.token)}
                      className="server-menu__member-action-btn"
                      style={{ flexShrink: 0 }}
                    >
                      copy
                    </button>
                    <button
                      onClick={() => setResetTokenData(null)}
                      className="server-menu__member-action-btn"
                      style={{ flexShrink: 0 }}
                    >
                      dismiss
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
