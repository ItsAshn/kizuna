import { useEffect, useState, useRef } from 'react'
import { useServerStore } from '../store/serverStore'
import {
  fetchRoles,
  fetchChannelOverrides,
  setChannelOverride,
  deleteChannelOverride,
} from '@kizuna/shared'
import type { CustomRole, Permission, Channel } from '@kizuna/shared'
import '../styles/channel-settings.css'

interface Props {
  channel: Channel
  onClose: () => void
}

const ALL_PERMISSIONS: { key: Permission; label: string }[] = [
  { key: 'send_messages', label: 'Send' },
  { key: 'add_reactions', label: 'React' },
  { key: 'upload_attachments', label: 'Attach' },
  { key: 'use_voice', label: 'Voice' },
]

type ToggleState = 'inherit' | 'allow' | 'deny'

export default function ChannelSettingsModal({ channel, onClose }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const serverUrl = session?.url
  const [tab, setTab] = useState<'overview' | 'permissions'>('permissions')
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [overrides, setOverrides] = useState<Record<string, { allow: Record<string, boolean>; deny: Record<string, boolean> }>>({})
  const [loading, setLoading] = useState(true)
  const [closing, setClosing] = useState(false)
  const mountedRef = useRef(false)
  mountedRef.current = true
  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  const handleClose = () => {
    if (closing) return
    setClosing(true)
    setTimeout(() => { if (mountedRef.current) onClose() }, 200)
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    if (!serverUrl) return
    setLoading(true)
    Promise.all([
      fetchRoles(serverUrl),
      fetchChannelOverrides(serverUrl, channel.id),
    ]).then(([allRoles, channelOverrides]) => {
      if (!mountedRef.current) return
      setRoles(allRoles.filter(r => !r.is_admin))
      const ov: Record<string, { allow: Record<string, boolean>; deny: Record<string, boolean> }> = {}
      for (const o of channelOverrides) {
        ov[o.role_id] = { allow: o.allow_permissions, deny: o.deny_permissions }
      }
      setOverrides(ov)
    }).catch(() => {}).finally(() => {
      if (mountedRef.current) setLoading(false)
    })
  }, [serverUrl, channel.id])

  function getToggleState(roleId: string, perm: Permission): ToggleState {
    const ov = overrides[roleId]
    if (!ov) return 'inherit'
    if (ov.deny[perm]) return 'deny'
    if (ov.allow[perm]) return 'allow'
    return 'inherit'
  }

  function cycleToggle(roleId: string, perm: Permission) {
    const current = getToggleState(roleId, perm)
    const next: ToggleState = current === 'inherit' ? 'allow' : current === 'allow' ? 'deny' : 'inherit'

    if (next === 'inherit') {
      const updated = { ...overrides }
      if (updated[roleId]) {
        const newAllow = { ...updated[roleId].allow }
        const newDeny = { ...updated[roleId].deny }
        delete newAllow[perm]
        delete newDeny[perm]
        if (Object.keys(newAllow).length === 0 && Object.keys(newDeny).length === 0) {
          delete updated[roleId]
          if (serverUrl) deleteChannelOverride(serverUrl, channel.id, roleId).catch(() => {})
        } else {
          updated[roleId] = { allow: newAllow, deny: newDeny }
          if (serverUrl) setChannelOverride(serverUrl, channel.id, roleId, newAllow, newDeny).catch(() => {})
        }
      }
      setOverrides(updated)
      return
    }

    const newAllow = { ...(overrides[roleId]?.allow || {}) }
    const newDeny = { ...(overrides[roleId]?.deny || {}) }
    if (next === 'allow') {
      newAllow[perm] = true
      delete newDeny[perm]
    } else {
      newDeny[perm] = true
      delete newAllow[perm]
    }
    const updated = { ...overrides, [roleId]: { allow: newAllow, deny: newDeny } }
    setOverrides(updated)

    if (serverUrl) setChannelOverride(serverUrl, channel.id, roleId, newAllow, newDeny).catch(() => {})
  }

  return (
    <div className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`} onClick={handleClose}>
      <div className={`channel-settings${closing ? ' channel-settings--closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="channel-settings__header">
          <span className="channel-settings__header-title">Channel Settings — #{channel.name}</span>
          <button onClick={handleClose} className="channel-settings__close-btn">[esc]</button>
        </div>

        <div className="channel-settings__body">
          <div className="channel-settings__tab-bar">
            {(['overview', 'permissions'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`channel-settings__tab ${tab === t ? 'channel-settings__tab--active' : ''}`}>
                {t}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div style={{ marginTop: '16px' }}>
              <div className="channel-settings__field">
                <label className="channel-settings__label">name</label>
                <p className="channel-settings__value">#{channel.name}</p>
              </div>
              <div className="channel-settings__field">
                <label className="channel-settings__label">type</label>
                <p className="channel-settings__value">{channel.type}</p>
              </div>
              {channel.topic && (
                <div className="channel-settings__field">
                  <label className="channel-settings__label">topic</label>
                  <p className="channel-settings__value">{channel.topic}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'permissions' && (
            <div style={{ marginTop: '16px' }}>
              <p className="channel-settings__section-title">Permission Overrides</p>
              <p className="channel-settings__hint">
                Click to cycle: <span className="channel-settings__legend-item"><span className="channel-settings__legend-dot channel-settings__legend-dot--inherit" /> inherit</span>
                {' → '}
                <span className="channel-settings__legend-item"><span className="channel-settings__legend-dot channel-settings__legend-dot--allow" /> allow</span>
                {' → '}
                <span className="channel-settings__legend-item"><span className="channel-settings__legend-dot channel-settings__legend-dot--deny" /> deny</span>
              </p>

              {loading ? (
                <p className="channel-settings__loading">loading...</p>
              ) : (
                <div className="channel-settings__perm-matrix">
                  <div className="channel-settings__perm-header">
                    <span className="channel-settings__perm-header-role">Role</span>
                    {ALL_PERMISSIONS.map(p => (
                      <span key={p.key} className="channel-settings__perm-header-col">{p.label}</span>
                    ))}
                  </div>
                  {roles.filter(r => !r.is_admin).sort((a, b) => (b.position ?? 0) - (a.position ?? 0)).map(role => (
                    <div key={role.id} className="channel-settings__perm-row">
                      <div className="channel-settings__perm-role">
                        <span className="channel-settings__perm-role-dot" style={{ backgroundColor: role.color }} />
                        <span className="channel-settings__perm-role-name" style={{ color: role.color }}>{role.name}</span>
                      </div>
                      {ALL_PERMISSIONS.map(p => {
                        const state = getToggleState(role.id, p.key)
                        return (
                          <div key={p.key} className="channel-settings__perm-cell">
                            <button
                              onClick={() => cycleToggle(role.id, p.key)}
                              className={`channel-settings__perm-btn channel-settings__perm-btn--${state}`}
                              title={`${role.name}: ${p.label} — ${state}`}
                            />
                          </div>
                        )
                      })}
                    </div>
                  ))}
                  {roles.filter(r => !r.is_admin).length === 0 && (
                    <p className="channel-settings__loading">No custom roles exist. Create one in server menu.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="channel-settings__footer">
          <button onClick={handleClose} className="channel-settings__done-btn">done</button>
        </div>
      </div>
    </div>
  )
}
