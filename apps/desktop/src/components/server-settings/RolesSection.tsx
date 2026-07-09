import { useEffect, useState } from 'react'
import { fetchRoles, createRole, updateRole, deleteRole, reorderRoles } from '@kizuna/shared'
import type { CustomRole, Permission } from '@kizuna/shared'
import { useChatStore } from '../../store/chatStore'
import { handleApiErr, useMountedRef } from './common'
import './RolesSection.css'

const ALL_PERMISSIONS: { key: Permission; label: string; desc: string }[] = [
  { key: 'send_messages', label: 'send', desc: 'Post messages in guild text channels' },
  { key: 'send_dm_messages', label: 'dm', desc: 'Send direct messages to other users' },
  { key: 'add_reactions', label: 'react', desc: 'Add emoji and sticker reactions to messages' },
  { key: 'upload_attachments', label: 'attach', desc: 'Upload files, images, and attachments' },
  { key: 'delete_messages', label: 'delete', desc: 'Remove messages from any user' },
  { key: 'manage_channels', label: 'channels', desc: 'Create, edit, and delete channels' },
  { key: 'manage_roles', label: 'roles', desc: 'Create, edit, delete, and assign roles' },
  { key: 'kick_members', label: 'kick', desc: 'Remove members from the server' },
  { key: 'ban_members', label: 'ban', desc: 'Permanently ban members from the server' },
  { key: 'manage_invites', label: 'invites', desc: 'Create and revoke invite codes' },
  { key: 'use_voice', label: 'voice', desc: 'Join and speak in guild voice channels' },
  { key: 'initiate_dm_calls', label: 'dm call', desc: 'Start and accept DM voice calls' },
]

export function RolesSection({ serverUrl }: { serverUrl: string | undefined }) {
  const mountedRef = useMountedRef()
  const { members, setMembers } = useChatStore()

  const [roles, setRoles] = useState<CustomRole[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleColor, setNewRoleColor] = useState('#4c6ef5')
  const [newRolePerms, setNewRolePerms] = useState<Partial<Record<Permission, boolean>>>({})
  const [newRoleHoist, setNewRoleHoist] = useState(false)
  const [newRoleMentionable, setNewRoleMentionable] = useState(false)
  const [newRoleDefaultOnJoin, setNewRoleDefaultOnJoin] = useState(false)
  const [creatingRole, setCreatingRole] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editPerms, setEditPerms] = useState<Partial<Record<Permission, boolean>>>({})
  const [editHoist, setEditHoist] = useState(false)
  const [editMentionable, setEditMentionable] = useState(false)
  const [editDefaultOnJoin, setEditDefaultOnJoin] = useState(false)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [showCreateRole, setShowCreateRole] = useState(false)
  const [reorderingRoles, setReorderingRoles] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)

  useEffect(() => {
    if (!serverUrl) return
    setRolesLoading(true)
    fetchRoles(serverUrl)
      .then(r => { if (mountedRef.current) setRoles(r) })
      .catch(err => console.error('Failed to fetch roles:', err))
      .finally(() => { if (mountedRef.current) setRolesLoading(false) })
  }, [serverUrl])

  function memberRoleCount(roleId: string): number {
    return members.filter(m => (m.custom_roles || []).some(r => r.id === roleId)).length
  }

  const handleCreateRole = async () => {
    if (!newRoleName.trim() || !serverUrl) return
    setCreatingRole(true)
    try {
      const role = await createRole(serverUrl, newRoleName.trim(), newRoleColor, newRolePerms, newRoleHoist, newRoleMentionable, newRoleDefaultOnJoin)
      setRoles(prev => [...prev, role])
      setNewRoleName('')
      setNewRoleColor('#4c6ef5')
      setNewRolePerms({})
      setNewRoleHoist(false)
      setNewRoleMentionable(false)
      setNewRoleDefaultOnJoin(false)
      setShowCreateRole(false)
      setRoleError(null)
    } catch (err) {
      console.error('Failed to create role:', err)
      setRoleError(handleApiErr(err))
    }
    setCreatingRole(false)
  }

  const handleStartEditRole = (role: CustomRole) => {
    setEditingRoleId(role.id)
    setEditName(role.name)
    setEditColor(role.color)
    setEditPerms({ ...role.permissions })
    setEditHoist(role.hoist ?? false)
    setEditMentionable(role.mentionable ?? false)
    setEditDefaultOnJoin(role.default_on_join ?? false)
  }

  const handleSaveRole = async (id: string) => {
    if (!serverUrl) return
    setSavingRoleId(id)
    try {
      const updated = await updateRole(serverUrl, id, editName, editColor, editPerms, editHoist, editMentionable, editDefaultOnJoin)
      setRoles(prev => prev.map(r => r.id === id ? updated : r))
      setMembers(members.map(m => ({
        ...m,
        custom_role_id: m.custom_role_id === id ? id : m.custom_role_id,
        custom_role_name: m.custom_role_id === id ? updated.name : m.custom_role_name,
        custom_role_color: m.custom_role_id === id ? updated.color : m.custom_role_color,
        custom_roles: (m.custom_roles || []).map(r => r.id === id ? { ...r, name: updated.name, color: updated.color } : r),
      })))
      setEditingRoleId(null)
      setRoleError(null)
    } catch (err) {
      console.error('Failed to save role:', err)
      setRoleError(handleApiErr(err))
    }
    setSavingRoleId(null)
  }

  const handleDeleteRole = async (id: string) => {
    const count = memberRoleCount(id)
    const msg = `Delete this role? It will be unassigned from ${count} member${count !== 1 ? 's' : ''}.`
    if (!confirm(msg)) return
    if (!serverUrl) return
    try {
      await deleteRole(serverUrl, id)
      setRoles(prev => prev.filter(r => r.id !== id))
      setMembers(members.map(m => ({
        ...m,
        custom_role_id: m.custom_role_id === id ? null : m.custom_role_id,
        custom_role_name: m.custom_role_id === id ? null : m.custom_role_name,
        custom_role_color: m.custom_role_id === id ? null : m.custom_role_color,
        custom_roles: (m.custom_roles || []).filter(r => r.id !== id),
      })))
      if (editingRoleId === id) setEditingRoleId(null)
      setRoleError(null)
    } catch (err) {
      console.error('Failed to delete role:', err)
      setRoleError(handleApiErr(err))
    }
  }

  return (
    <div className="server-menu__section">
      {!showCreateRole ? (
        <button
          onClick={() => setShowCreateRole(true)}
          className="server-menu__role-create-btn"
          style={{ marginBottom: '16px' }}
        >
          + create role
        </button>
      ) : (
        <div className="server-menu__role-create">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <p className="server-menu__section-title" style={{ margin: 0 }}>create role</p>
            <button onClick={() => setShowCreateRole(false)} className="server-menu__member-action-btn">cancel</button>
          </div>
          <div className="server-menu__role-create-row">
            <input className="server-menu__role-create-input" placeholder="role name" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} maxLength={50} />
            <input type="color" className="server-menu__color-input" value={newRoleColor} onChange={(e) => setNewRoleColor(e.target.value)} />
          </div>
          <div className="server-menu__perm-toggles">
            {ALL_PERMISSIONS.map(p => (
              <button key={p.key}
                onClick={() => setNewRolePerms(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                className={`server-menu__perm-toggle ${newRolePerms[p.key] ? 'server-menu__perm-toggle--on' : ''}`}
                title={p.desc}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="server-menu__role-flags">
            <label className="server-menu__role-flag">
              <input type="checkbox" checked={newRoleHoist} onChange={(e) => setNewRoleHoist(e.target.checked)} />
              <span>Display members separately</span>
            </label>
            <label className="server-menu__role-flag">
              <input type="checkbox" checked={newRoleMentionable} onChange={(e) => setNewRoleMentionable(e.target.checked)} />
              <span>Allow @role mentions</span>
            </label>
            <label className="server-menu__role-flag">
              <input type="checkbox" checked={newRoleDefaultOnJoin} onChange={(e) => setNewRoleDefaultOnJoin(e.target.checked)} />
              <span>Assign on join</span>
            </label>
          </div>
          <button onClick={handleCreateRole} disabled={creatingRole || !newRoleName.trim()}
            className="server-menu__role-create-btn">
            {creatingRole ? '...' : 'create role'}
          </button>
          {roleError && (
            <span className="server-menu__save-msg server-menu__save-msg--err" style={{ marginTop: '6px' }}>{roleError}</span>
          )}
        </div>
      )}

      {rolesLoading ? (
        <p className="server-menu__loading">loading...</p>
      ) : roles.length === 0 ? (
        <p className="server-menu__loading">no custom roles</p>
      ) : (
        roles.map((role, idx) => {
          const count = memberRoleCount(role.id)
          return (
            <div key={role.id} className="server-menu__role-item">
              {editingRoleId === role.id ? (
                <div>
                  <div className="server-menu__role-create-row">
                    <input className="server-menu__role-create-input" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={50} />
                    <input type="color" className="server-menu__color-input" value={editColor} onChange={(e) => setEditColor(e.target.value)} />
                  </div>
                  <div className="server-menu__perm-toggles">
                    {ALL_PERMISSIONS.map(p => (
                      <button key={p.key}
                        onClick={() => setEditPerms(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                        className={`server-menu__perm-toggle ${editPerms[p.key] ? 'server-menu__perm-toggle--on' : ''}`}
                        title={p.desc}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="server-menu__role-flags">
                    <label className="server-menu__role-flag">
                      <input type="checkbox" checked={editHoist} onChange={(e) => setEditHoist(e.target.checked)} />
                      <span>Display members separately</span>
                    </label>
                    <label className="server-menu__role-flag">
                      <input type="checkbox" checked={editMentionable} onChange={(e) => setEditMentionable(e.target.checked)} />
                      <span>Allow @role mentions</span>
                    </label>
                    <label className="server-menu__role-flag">
                      <input type="checkbox" checked={editDefaultOnJoin} onChange={(e) => setEditDefaultOnJoin(e.target.checked)} />
                      <span>Assign on join</span>
                    </label>
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
                    <span className="server-menu__role-color-dot" style={{ backgroundColor: role.color }} />
                    <span className="server-menu__role-name" style={{ color: role.color }}>{role.name}</span>
                    {count > 0 && <span className="server-menu__role-count">{count} member{count !== 1 ? 's' : ''}</span>}
                    {role.hoist && <span className="server-menu__role-tag">hoist</span>}
                    {role.mentionable && <span className="server-menu__role-tag">@</span>}
                    {role.default_on_join && <span className="server-menu__role-tag">join</span>}
                    <div className="server-menu__role-actions">
                      {!role.is_admin && (
                        <>
                          <button
                            onClick={async () => {
                              if (!serverUrl) return
                              setReorderingRoles(true)
                              const newRoles = [...roles]
                              if (idx > 0) {
                                const prev = newRoles[idx - 1]
                                const prevPos = prev.position ?? 0
                                const myPos = role.position ?? 0
                                const order = [
                                  { id: role.id, position: prevPos },
                                  { id: prev.id, position: myPos },
                                ]
                                try {
                                  await reorderRoles(serverUrl, order)
                                  newRoles[idx] = { ...role, position: prevPos }
                                  newRoles[idx - 1] = { ...prev, position: myPos }
                                  newRoles.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                                  setRoles(newRoles)
                                } catch (err) {
                                  console.error('Failed to reorder role up:', err)
                                }
                              }
                              setReorderingRoles(false)
                            }}
                            disabled={idx === 0 || reorderingRoles}
                            className="server-menu__role-action-btn"
                            title="Move up"
                          >&#9650;</button>
                          <button
                            onClick={async () => {
                              if (!serverUrl) return
                              setReorderingRoles(true)
                              const newRoles = [...roles]
                              if (idx < newRoles.length - 1) {
                                const next = newRoles[idx + 1]
                                const nextPos = next.position ?? 0
                                const myPos = role.position ?? 0
                                const order = [
                                  { id: role.id, position: nextPos },
                                  { id: next.id, position: myPos },
                                ]
                                try {
                                  await reorderRoles(serverUrl, order)
                                  newRoles[idx] = { ...role, position: nextPos }
                                  newRoles[idx + 1] = { ...next, position: myPos }
                                  newRoles.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                                  setRoles(newRoles)
                                } catch (err) {
                                  console.error('Failed to reorder role down:', err)
                                }
                              }
                              setReorderingRoles(false)
                            }}
                            disabled={idx === roles.length - 1 || reorderingRoles}
                            className="server-menu__role-action-btn"
                            title="Move down"
                          >&#9660;</button>
                        </>
                      )}
                      <button onClick={() => handleStartEditRole(role)} className="server-menu__role-action-btn">edit</button>
                      <button onClick={() => handleDeleteRole(role.id)} className="server-menu__role-action-btn server-menu__role-action-btn--danger">delete</button>
                    </div>
                  </div>
                  <div className="server-menu__perm-toggles">
                    {ALL_PERMISSIONS.map(p => (
                      <span key={p.key}
                        className={`server-menu__perm-toggle ${role.permissions?.[p.key] ? 'server-menu__perm-toggle--on' : ''}`}
                        style={{ cursor: 'default' }}
                        title={p.desc}
                      >
                        {p.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })
      )}
      {!showCreateRole && roleError && (
        <span className="server-menu__save-msg server-menu__save-msg--err" style={{ marginTop: '8px', display: 'block' }}>{roleError}</span>
      )}
    </div>
  )
}
