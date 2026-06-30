import { useEffect, useState, useRef } from 'react'
import { useServerStore } from '../store/serverStore'
import {
  fetchRoles,
  fetchChannelOverrides,
  setChannelOverride,
  deleteChannelOverride,
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
} from '@kizuna/shared'
import type { CustomRole, Permission, Channel } from '@kizuna/shared'
import Modal from './ui/Modal'
import Tabs from './ui/Tabs'
import './ChannelSettingsModal.css'

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

const PERM_TABS = [
  { key: 'overview', label: 'overview' },
  { key: 'permissions', label: 'permissions' },
  { key: 'integrations', label: 'integrations' },
]

export default function ChannelSettingsModal({ channel, onClose }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const serverUrl = session?.url
  const [tab, setTab] = useState<'overview' | 'permissions' | 'integrations'>('permissions')
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [overrides, setOverrides] = useState<Record<string, { allow: Record<string, boolean>; deny: Record<string, boolean> }>>({})
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(false)
  mountedRef.current = true
  useEffect(() => {
    return () => { mountedRef.current = false }
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

  const [webhooks, setWebhooks] = useState<{ id: string; name: string; token: string; channel_id: string; created_at: number }[]>([])
  const [whName, setWhName] = useState('')
  const [whLoading, setWhLoading] = useState(false)
  const [whError, setWhError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    if (!serverUrl) return
    fetchWebhooks(serverUrl, channel.id).then((r) => setWebhooks(r.webhooks)).catch(() => {})
  }, [serverUrl, channel.id])

  const handleCreateWebhook = async () => {
    if (!serverUrl || !whName.trim()) return
    setWhLoading(true); setWhError('')
    try {
      await createWebhook(serverUrl, channel.id, whName.trim())
      setWhName('')
      const r = await fetchWebhooks(serverUrl, channel.id)
      setWebhooks(r.webhooks)
    } catch (err: unknown) {
      setWhError(err instanceof Error ? err.message : String(err))
    } finally { setWhLoading(false) }
  }

  const handleDeleteWebhook = async (id: string) => {
    if (!serverUrl) return
    try {
      await deleteWebhook(serverUrl, id)
      setWebhooks((prev) => prev.filter((w) => w.id !== id))
    } catch (err: unknown) {
      setWhError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCopy = async (token: string, id: string) => {
    try {
      await navigator.clipboard.writeText(`${serverUrl ?? ''}/api/webhooks/incoming/${token}`)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch { /* ignore */ }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Channel Settings — #${channel.name}`}
      className="channel-settings"
      footer={(handleClose) => (
        <button onClick={handleClose} className="channel-settings__done-btn">done</button>
      )}
    >
      <Tabs tabs={PERM_TABS} activeKey={tab} onChange={(k) => setTab(k as typeof tab)} variant="underline" />

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

      {tab === 'integrations' && (
        <div style={{ marginTop: '16px' }}>
          <p className="channel-settings__section-title">Incoming Webhooks</p>
          <p className="channel-settings__hint">
            Post messages to this channel from external services like bots, CI/CD, or GitHub.
          </p>

          <div className="channel-settings__field" style={{ marginTop: '12px' }}>
            <label className="channel-settings__label">name</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                className="channel-settings__input"
                placeholder="My Bot"
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="channel-settings__save-btn"
                onClick={handleCreateWebhook}
                disabled={whLoading || !whName.trim()}
              >
                {whLoading ? 'creating...' : 'create'}
              </button>
            </div>
          </div>

          {whError && <p className="channel-settings__error">{whError}</p>}

          <div style={{ marginTop: '20px' }}>
            {webhooks.length > 0 ? (
              webhooks.map((wh) => (
                <div key={wh.id} className="channel-settings__webhook-item">
                  <div className="channel-settings__webhook-item-info">
                    <span className="channel-settings__webhook-item-name">{wh.name}</span>
                    <span className="channel-settings__webhook-item-date">
                      {new Date(wh.created_at * 1000).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="channel-settings__webhook-item-actions">
                    <button
                      className={`channel-settings__save-btn${copiedId === wh.id ? ' channel-settings__save-btn--copied' : ''}`}
                      onClick={() => handleCopy(wh.token, wh.id)}
                      style={{ fontSize: '11px', padding: '4px 10px' }}
                    >
                      {copiedId === wh.id ? 'copied!' : 'copy url'}
                    </button>
                    <button
                      className="channel-settings__delete-btn"
                      onClick={() => handleDeleteWebhook(wh.id)}
                    >
                      delete
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="channel-settings__loading">no webhooks configured</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
