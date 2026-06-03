import { useEffect, useState, useRef, useCallback } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import {
  updateProfile,
  updateServerSettings,
  fetchMembers,
  createInvite,
  fetchInvites,
  revokeInvite,
  setMemberRole,
  kickMember,
  assignCustomRole,
  fetchRoles,
  createRole,
  updateRole,
  deleteRole,
} from '@kizuna/shared'
import type { Member, CustomRole, Permission } from '@kizuna/shared'
import '../styles/server-menu.css'

interface Props {
  onClose: () => void
}

function handleApiErr(err: unknown): string {
  const e = err as any
  return e?.response?.data?.error || 'request failed'
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

type AdminTab = 'settings' | 'members' | 'invites' | 'roles'

const ALL_PERMISSIONS: { key: Permission; label: string }[] = [
  { key: 'send_messages', label: 'send' },
  { key: 'manage_channels', label: 'channels' },
  { key: 'delete_messages', label: 'delete' },
  { key: 'kick_members', label: 'kick' },
  { key: 'manage_invites', label: 'invites' },
]

const EXPIRY_OPTIONS = [
  { label: 'never', value: '0' },
  { label: '1 hour', value: '1' },
  { label: '6 hours', value: '6' },
  { label: '1 day', value: '24' },
  { label: '7 days', value: '168' },
  { label: '30 days', value: '720' },
]

export default function ServerMenuModal({ onClose }: Props) {
  const { activeSession: session, updateServerInfo, servers } = useServerStore()
  const { members, setMembers } = useChatStore()
  const serverUrl = session?.url
  const token = session?.token
  const isAdmin = session?.user?.role === 'admin'
  const [closing, setClosing] = useState(false)

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => onClose(), 200)
  }, [closing, onClose])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleClose])

  // ─── Profile ─────────────────────────────────────────
  const [displayName, setDisplayName] = useState(session?.user?.display_name ?? '')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(session?.user?.avatar ?? null)
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState<string | null>(null)
  const profileFileRef = useRef<HTMLInputElement>(null)
  const pendingAvatarFile = useRef<File | null>(null)

  // ─── Admin tab ───────────────────────────────────────
  const [adminTab, setAdminTab] = useState<AdminTab>('settings')

  // ─── Server settings ─────────────────────────────────
  const [serverName, setServerName] = useState(session ? servers.find(s => s.id === session.serverId)?.name ?? '' : '')
  const [serverIconPreview, setServerIconPreview] = useState<string | null>(null)
  const [serverIconChanged, setServerIconChanged] = useState(false)
  const [serverSaving, setServerSaving] = useState(false)
  const [serverMsg, setServerMsg] = useState<string | null>(null)
  const serverIconFileRef = useRef<HTMLInputElement>(null)
  const pendingServerIconFile = useRef<File | null>(null)

  // ─── Members ─────────────────────────────────────────
  const [membersLoading, setMembersLoading] = useState(false)
  const [memberMsg, setMemberMsg] = useState<Record<string, string>>({})

  // ─── Invites ─────────────────────────────────────────
  const [invites, setInvites] = useState<any[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [newMaxUses, setNewMaxUses] = useState('')
  const [newExpiry, setNewExpiry] = useState('0')
  const [creatingInvite, setCreatingInvite] = useState(false)

  // ─── Roles ───────────────────────────────────────────
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleColor, setNewRoleColor] = useState('#5865f2')
  const [newRolePerms, setNewRolePerms] = useState<Partial<Record<Permission, boolean>>>({})
  const [creatingRole, setCreatingRole] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editPerms, setEditPerms] = useState<Partial<Record<Permission, boolean>>>({})
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [assigningRole, setAssigningRole] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!isAdmin || !serverUrl || !token) return
    if (adminTab === 'members') {
      setMembersLoading(true)
      fetchMembers(serverUrl, token).then(setMembers).catch(console.error).finally(() => setMembersLoading(false))
      loadRoles()
    } else if (adminTab === 'invites') {
      loadInvites()
    } else if (adminTab === 'roles') {
      loadRoles()
    }
  }, [adminTab, isAdmin, serverUrl, token])

  async function loadInvites() {
    if (!serverUrl || !token) return
    setInvitesLoading(true)
    try { setInvites(await fetchInvites(serverUrl, token)) } catch {}
    setInvitesLoading(false)
  }

  async function loadRoles() {
    if (!serverUrl || !token) return
    setRolesLoading(true)
    try { setRoles(await fetchRoles(serverUrl, token)) } catch {}
    setRolesLoading(false)
  }

  // ─── Profile handlers ───────────────────────────────
  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setProfileMsg(null)
    pendingAvatarFile.current = file
    const url = URL.createObjectURL(file)
    setAvatarPreview(url)
    setAvatarChanged(true)
    e.target.value = ''
  }

  const handleSaveProfile = async () => {
    if (!serverUrl || !token || !session) return
    setProfileSaving(true)
    setProfileMsg(null)
    try {
      let avatarPayload: string | null | undefined = undefined
      if (avatarChanged) {
        if (avatarPreview === null) {
          avatarPayload = null
          pendingAvatarFile.current = null
        } else if (pendingAvatarFile.current) {
          avatarPayload = await fileToDataUrl(pendingAvatarFile.current)
        }
      }
      const updated = await updateProfile(serverUrl, token, displayName, avatarPayload)
      useServerStore.getState().setActiveSession({ ...session, user: updated })
      useServerStore.getState().updateServerInfo(session.serverId, { name: updated.display_name })
      setAvatarChanged(false)
      pendingAvatarFile.current = null
      setProfileMsg('saved')
    } catch (err) {
      setProfileMsg(handleApiErr(err))
    }
    setProfileSaving(false)
  }

  // ─── Server settings handlers ───────────────────────
  const handleServerIconFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setServerMsg(null)
    pendingServerIconFile.current = file
    const url = URL.createObjectURL(file)
    setServerIconPreview(url)
    setServerIconChanged(true)
    e.target.value = ''
  }

  const handleSaveServer = async () => {
    if (!serverUrl || !token || !session) return
    setServerSaving(true)
    setServerMsg(null)
    try {
      let iconPayload: string | null | undefined = undefined
      if (serverIconChanged) {
        if (serverIconPreview === null) {
          iconPayload = null
          pendingServerIconFile.current = null
        } else if (pendingServerIconFile.current) {
          iconPayload = await fileToDataUrl(pendingServerIconFile.current)
        }
      }
      const res = await updateServerSettings(serverUrl, token, serverName, iconPayload)
      updateServerInfo(session.serverId, { name: res.name, icon: res.icon ?? undefined })
      setServerIconChanged(false)
      pendingServerIconFile.current = null
      setServerMsg('saved')
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
    setServerSaving(false)
  }

  // ─── Member handlers ────────────────────────────────
  const handleToggleRole = async (m: Member) => {
    if (!serverUrl || !token) return
    const newRole = m.role === 'admin' ? 'member' : 'admin'
    try {
      await setMemberRole(serverUrl, token, m.id, newRole)
      setMembers(members.map(x => x.id === m.id ? { ...x, role: newRole } : x))
      setMemberMsg(prev => ({ ...prev, [m.id]: `role → ${newRole}` }))
      setTimeout(() => setMemberMsg(prev => { const n = { ...prev }; delete n[m.id]; return n }), 2000)
    } catch (err) {
      setMemberMsg(prev => ({ ...prev, [m.id]: handleApiErr(err) }))
    }
  }

  const handleKick = async (m: Member) => {
    if (!confirm(`Kick ${m.display_name || m.username}? They can rejoin via invite.`)) return
    if (!serverUrl || !token) return
    try {
      await kickMember(serverUrl, token, m.id)
      setMembers(members.filter(x => x.id !== m.id))
    } catch (err) {
      setMemberMsg(prev => ({ ...prev, [m.id]: handleApiErr(err) }))
    }
  }

  const handleAssignCustomRole = async (userId: string, roleId: string | null) => {
    if (!serverUrl || !token) return
    setAssigningRole(prev => ({ ...prev, [userId]: true }))
    try {
      await assignCustomRole(serverUrl, token, userId, roleId)
      setMembers(members.map(x =>
        x.id === userId ? {
          ...x,
          custom_role_id: roleId,
          custom_role_name: roles.find(r => r.id === roleId)?.name ?? null,
          custom_role_color: roles.find(r => r.id === roleId)?.color ?? null,
        } : x,
      ))
    } catch {}
    setAssigningRole(prev => ({ ...prev, [userId]: false }))
  }

  // ─── Invite handlers ────────────────────────────────
  const handleCreateInvite = async () => {
    if (!serverUrl || !token) return
    setCreatingInvite(true)
    try {
      const maxUses = newMaxUses ? parseInt(newMaxUses, 10) : undefined
      const expiresInHours = newExpiry !== '0' ? parseFloat(newExpiry) : undefined
      const invite = await createInvite(serverUrl, token, maxUses, expiresInHours)
      setInvites(prev => [invite, ...prev])
      setNewMaxUses('')
      setNewExpiry('0')
    } catch {}
    setCreatingInvite(false)
  }

  const handleRevokeInvite = async (code: string) => {
    if (!serverUrl || !token) return
    try {
      await revokeInvite(serverUrl, token, code)
      setInvites(prev => prev.filter(i => i.code !== code))
    } catch {}
  }

  // ─── Role handlers ──────────────────────────────────
  const handleCreateRole = async () => {
    if (!newRoleName.trim() || !serverUrl || !token) return
    setCreatingRole(true)
    try {
      const role = await createRole(serverUrl, token, newRoleName.trim(), newRoleColor, newRolePerms)
      setRoles(prev => [...prev, role])
      setNewRoleName('')
      setNewRoleColor('#5865f2')
      setNewRolePerms({})
    } catch {}
    setCreatingRole(false)
  }

  const handleStartEditRole = (role: CustomRole) => {
    setEditingRoleId(role.id)
    setEditName(role.name)
    setEditColor(role.color)
    setEditPerms({ ...role.permissions })
  }

  const handleSaveRole = async (id: string) => {
    if (!serverUrl || !token) return
    setSavingRoleId(id)
    try {
      const updated = await updateRole(serverUrl, token, id, editName, editColor, editPerms)
      setRoles(prev => prev.map(r => r.id === id ? updated : r))
      setMembers(members.map(m =>
        m.custom_role_id === id ? { ...m, custom_role_name: updated.name, custom_role_color: updated.color } : m,
      ))
      setEditingRoleId(null)
    } catch {}
    setSavingRoleId(null)
  }

  const handleDeleteRole = async (id: string) => {
    if (!confirm('Delete this role? It will be unassigned from all members.')) return
    if (!serverUrl || !token) return
    try {
      await deleteRole(serverUrl, token, id)
      setRoles(prev => prev.filter(r => r.id !== id))
      setMembers(members.map(m => m.custom_role_id === id ? { ...m, custom_role_id: null, custom_role_name: null, custom_role_color: null } : m))
      if (editingRoleId === id) setEditingRoleId(null)
    } catch {}
  }

  return (
    <div className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`} onClick={handleClose}>
      <div className={`server-menu${closing ? ' server-menu--closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="server-menu__header">
          <span className="server-menu__header-title">// server menu</span>
          <button onClick={handleClose} className="server-menu__close-btn">[esc]</button>
        </div>

        <div className="server-menu__body">
          {/* Profile */}
          <section>
            <p className="server-menu__section-title">your profile</p>
            <div className="server-menu__avatar-row">
              <div className="server-menu__avatar" onClick={() => profileFileRef.current?.click()} title="click to change avatar">
                <span>{(displayName || session?.user?.display_name || '?')[0]?.toUpperCase()}</span>
                {avatarPreview && <img src={avatarPreview} alt="" className="server-menu__avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
              </div>
              <div className="server-menu__avatar-actions">
                <button onClick={() => profileFileRef.current?.click()} className="server-menu__upload-btn">upload image</button>
                {avatarPreview && (
                  <button onClick={() => { pendingAvatarFile.current = null; setAvatarPreview(null); setAvatarChanged(true) }} className="server-menu__remove-btn">remove avatar</button>
                )}
              </div>
              <input ref={profileFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
            </div>
            <div className="server-menu__field" style={{ marginTop: '12px' }}>
              <label className="server-menu__label">display name</label>
              <input className="server-menu__input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="display name" />
            </div>
            <div className="server-menu__save-row">
              <button onClick={handleSaveProfile} disabled={profileSaving} className="server-menu__save-btn">
                {profileSaving ? '...' : 'save profile'}
              </button>
              {profileMsg && (
                <span className={`server-menu__save-msg ${profileMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
                  {profileMsg}
                </span>
              )}
            </div>
          </section>

          {/* Admin */}
          {isAdmin && (
            <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
              <p className="server-menu__section-title">admin</p>

              <div className="server-menu__tab-bar">
                {(['settings', 'members', 'invites', 'roles'] as AdminTab[]).map(t => (
                  <button key={t} onClick={() => setAdminTab(t)}
                    className={`server-menu__tab ${adminTab === t ? 'server-menu__tab--active' : ''}`}>
                    {t}
                  </button>
                ))}
              </div>

              {/* Settings tab */}
              {adminTab === 'settings' && (
                <div style={{ marginTop: '16px' }}>
                  <div className="server-menu__avatar-row">
                    <div className="server-menu__avatar" onClick={() => serverIconFileRef.current?.click()} title="click to change server icon">
                      <span>{(serverName || '?').slice(0, 2).toUpperCase()}</span>
                      {(serverIconPreview !== null ? serverIconPreview : (session ? servers.find(s => s.id === session.serverId)?.icon : undefined)) && (
                        <img src={serverIconPreview ?? session ? servers.find(s => s.id === session.serverId)?.icon : undefined} alt="" className="server-menu__avatar-img"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                      )}
                    </div>
                    <div className="server-menu__avatar-actions">
                      <button onClick={() => serverIconFileRef.current?.click()} className="server-menu__upload-btn">upload icon</button>
                      {serverIconPreview && (
                        <button onClick={() => { pendingServerIconFile.current = null; setServerIconPreview(null); setServerIconChanged(true) }}
                          className="server-menu__remove-btn">remove icon</button>
                      )}
                    </div>
                    <input ref={serverIconFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleServerIconFile} />
                  </div>
                  <div className="server-menu__field" style={{ marginTop: '12px' }}>
                    <label className="server-menu__label">server name</label>
                    <input className="server-menu__input" value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="server name" />
                  </div>
                  <div className="server-menu__save-row">
                    <button onClick={handleSaveServer} disabled={serverSaving} className="server-menu__save-btn">
                      {serverSaving ? '...' : 'save settings'}
                    </button>
                    {serverMsg && (
                      <span className={`server-menu__save-msg ${serverMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
                        {serverMsg}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Members tab */}
              {adminTab === 'members' && (
                <div style={{ marginTop: '16px' }}>
                  {membersLoading ? (
                    <p className="server-menu__loading">loading...</p>
                  ) : members.length === 0 ? (
                    <p className="server-menu__loading">no members</p>
                  ) : (
                    members.map(m => {
                      const isSelf = m.id === session?.user?.id
                      return (
                        <div key={m.id} className="server-menu__member">
                          <div className="server-menu__member-avatar">
                            <span>{(m.display_name || m.username)[0]?.toUpperCase()}</span>
                            {m.avatar && <img src={m.avatar} alt="" className="server-menu__member-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
                          </div>
                          <div className="server-menu__member-info">
                            <p className="server-menu__member-name">
                              {m.display_name || m.username}
                              {isSelf && <span className="server-menu__member-self">(you)</span>}
                            </p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                              <p className={`server-menu__member-role ${m.role === 'admin' ? 'server-menu__member-role--admin' : ''}`}>
                                {m.role ?? 'member'}
                              </p>
                              {m.custom_role_name && (
                                <span className="server-menu__member-badge"
                                  style={{ color: m.custom_role_color || '#5865f2', borderColor: (m.custom_role_color || '#5865f2') + '66', backgroundColor: (m.custom_role_color || '#5865f2') + '22' }}>
                                  {m.custom_role_name}
                                </span>
                              )}
                            </div>
                          </div>
                          {memberMsg[m.id] && <span className="server-menu__member-msg">{memberMsg[m.id]}</span>}
                          {!isSelf && (
                            <div className="server-menu__member-actions">
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button onClick={() => handleToggleRole(m)} className="server-menu__member-action-btn">
                                  {m.role === 'admin' ? 'demote' : 'promote'}
                                </button>
                                <button onClick={() => handleKick(m)} className="server-menu__member-action-btn server-menu__member-action-btn--danger">
                                  kick
                                </button>
                              </div>
                              {roles.length > 0 && (
                                <select
                                  value={m.custom_role_id ?? ''}
                                  disabled={assigningRole[m.id]}
                                  onChange={(e) => handleAssignCustomRole(m.id, e.target.value || null)}
                                  className="server-menu__input"
                                  style={{ fontSize: '9px', padding: '2px 4px' }}
                                >
                                  <option value="">no role</option>
                                  {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {/* Invites tab */}
              {adminTab === 'invites' && (
                <div style={{ marginTop: '16px' }}>
                  <div className="server-menu__invite-create">
                    <p className="server-menu__section-title" style={{ marginBottom: '8px' }}>create invite</p>
                    <div className="server-menu__invite-row">
                      <div className="server-menu__field">
                        <label className="server-menu__label">max uses (blank = infinite)</label>
                        <input type="number" min="1" className="server-menu__input" placeholder="unlimited" value={newMaxUses} onChange={(e) => setNewMaxUses(e.target.value)} />
                      </div>
                      <div className="server-menu__field">
                        <label className="server-menu__label">expires after</label>
                        <select className="server-menu__input" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)}>
                          {EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <button onClick={handleCreateInvite} disabled={creatingInvite} className="server-menu__role-create-btn">
                      {creatingInvite ? '...' : 'generate invite code'}
                    </button>
                  </div>

                  <p className="server-menu__section-title">active codes ({invites.length})</p>
                  {invitesLoading ? (
                    <p className="server-menu__loading">loading...</p>
                  ) : invites.length === 0 ? (
                    <p className="server-menu__loading">no active invite codes</p>
                  ) : (
                    invites.map(inv => (
                      <div key={inv.code} className="server-menu__invite-item">
                        <code className="server-menu__invite-code">{inv.code}</code>
                        <div className="server-menu__invite-stats">
                          <div>{inv.uses}/{inv.max_uses ?? '∞'} uses</div>
                          <div>{inv.expires_at ? new Date(inv.expires_at * 1000).toLocaleDateString() : 'never'}</div>
                        </div>
                        <button onClick={() => handleRevokeInvite(inv.code)} className="server-menu__invite-revoke">revoke</button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Roles tab */}
              {adminTab === 'roles' && (
                <div style={{ marginTop: '16px' }}>
                  <div className="server-menu__role-create">
                    <p className="server-menu__section-title" style={{ marginBottom: '8px' }}>create role</p>
                    <div className="server-menu__role-create-row">
                      <input className="server-menu__role-create-input" placeholder="role name" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
                      <input type="color" className="server-menu__color-input" value={newRoleColor} onChange={(e) => setNewRoleColor(e.target.value)} />
                    </div>
                    <div className="server-menu__perm-toggles">
                      {ALL_PERMISSIONS.map(p => (
                        <button key={p.key}
                          onClick={() => setNewRolePerms(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                          className={`server-menu__perm-toggle ${newRolePerms[p.key] ? 'server-menu__perm-toggle--on' : ''}`}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <button onClick={handleCreateRole} disabled={creatingRole || !newRoleName.trim()}
                      className="server-menu__role-create-btn">
                      {creatingRole ? '...' : 'create role'}
                    </button>
                  </div>

                  {rolesLoading ? (
                    <p className="server-menu__loading">loading...</p>
                  ) : roles.length === 0 ? (
                    <p className="server-menu__loading">no custom roles</p>
                  ) : (
                    roles.map(role => (
                      <div key={role.id} className="server-menu__role-item">
                        {editingRoleId === role.id ? (
                          <div>
                            <div className="server-menu__role-create-row">
                              <input className="server-menu__role-create-input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                              <input type="color" className="server-menu__color-input" value={editColor} onChange={(e) => setEditColor(e.target.value)} />
                            </div>
                            <div className="server-menu__perm-toggles">
                              {ALL_PERMISSIONS.map(p => (
                                <button key={p.key}
                                  onClick={() => setEditPerms(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                                  className={`server-menu__perm-toggle ${editPerms[p.key] ? 'server-menu__perm-toggle--on' : ''}`}>
                                  {p.label}
                                </button>
                              ))}
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button onClick={() => handleSaveRole(role.id)} disabled={savingRoleId === role.id}
                                className="server-menu__save-btn" style={{ fontSize: '10px' }}>
                                {savingRoleId === role.id ? '...' : 'save'}
                              </button>
                              <button onClick={() => setEditingRoleId(null)} className="server-menu__member-action-btn">
                                cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="server-menu__role-header">
                              <span className="server-menu__role-name" style={{ color: role.color }}>{role.name}</span>
                              <div className="server-menu__role-actions">
                                <button onClick={() => handleStartEditRole(role)} className="server-menu__role-action-btn">edit</button>
                                <button onClick={() => handleDeleteRole(role.id)} className="server-menu__role-action-btn server-menu__role-action-btn--danger">delete</button>
                              </div>
                            </div>
                            <div className="server-menu__perm-toggles">
                              {ALL_PERMISSIONS.map(p => (
                                <span key={p.key}
                                  className={`server-menu__perm-toggle ${(role.permissions as any)?.[p.key] ? 'server-menu__perm-toggle--on' : ''}`}
                                  style={{ cursor: 'default' }}>
                                  {p.label}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="server-menu__footer">
          <button onClick={handleClose} className="server-menu__done-btn">done</button>
        </div>
      </div>
    </div>
  )
}
