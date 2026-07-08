import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  User, Bell, SlidersHorizontal, Users, Link2, Shield, Code, Image as ImageIcon, Trash2,
} from 'lucide-react'
import Modal from './ui/Modal'
import SettingsLayout, { type SettingsNavGroup } from './ui/SettingsLayout'
import ToggleSwitch from './ui/ToggleSwitch'
import Checkbox from './ui/Checkbox'
import Slider from './ui/Slider'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  updateProfile,
  updateServerSettings,
  uploadServerBackground,
  deleteServerBackground,
  fetchServerInfo,
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
  fetchStorageStats,
  clearAuditLogs,
  cleanupOrphanFiles,
  deleteAccount,
} from '@kizuna/shared'
import './ServerMenuModal.css'
import { InvitesSection } from './server-settings/InvitesSection'
import { MembersSection } from './server-settings/MembersSection'
import { RolesSection } from './server-settings/RolesSection'
import { GifsSection } from './server-settings/GifsSection'

interface Props {
  onClose: () => void
  onBackgroundChanged?: () => void
}

function WebhooksSection() {
  const session = useServerStore((s) => s.activeSession)
  const channels = useChatStore((s) => s.channels)
  const [webhooks, setWebhooks] = useState<{ id: string; name: string; token: string; channel_id: string; created_at: number }[]>([])
  const [newName, setNewName] = useState('')
  const [newChannelId, setNewChannelId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    if (channels.length > 0 && !newChannelId) {
      const first = channels.find((c) => c.type === 'text')
      if (first) setNewChannelId(first.id)
    }
  }, [channels])

  const loadWebhooks = useCallback((channelId: string) => {
    if (!session) return
    fetchWebhooks(session.url, channelId).then((r) => setWebhooks(r.webhooks)).catch(() => {})
  }, [session])

  useEffect(() => {
    if (!newChannelId || !session) return
    loadWebhooks(newChannelId)
  }, [newChannelId, session, loadWebhooks])

  const handleCreate = async () => {
    if (!newName.trim() || !newChannelId || !session) return
    setLoading(true); setError('')
    try {
      await createWebhook(session.url, newChannelId, newName.trim())
      setNewName('')
      loadWebhooks(newChannelId)
    } catch (err) { setError(handleApiErr(err)) } finally { setLoading(false) }
  }

  const handleDelete = async (id: string) => {
    if (!session) return
    try {
      await deleteWebhook(session.url, id)
      setWebhooks((prev) => prev.filter((w) => w.id !== id))
    } catch (err) { setError(handleApiErr(err)) }
  }

  const handleCopy = async (token: string, id: string) => {
    try {
      await navigator.clipboard.writeText(`${session?.url ?? ''}/api/webhooks/incoming/${token}`)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch { /* ignore */ }
  }

  const textChannels = channels.filter((c) => c.type === 'text')
  const getChannelName = (channelId: string) => channels.find((c) => c.id === channelId)?.name ?? 'unknown'

  return (
    <>
      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">incoming webhooks</p>
        <p className="server-menu__css-hint" style={{ marginBottom: '12px' }}>
          Post messages to a channel from external services. Use the URL below to send messages from bots, CI/CD, or GitHub.
        </p>

        <div className="server-menu__field">
          <label className="server-menu__label">channel</label>
          <select
            className="server-menu__select"
            value={newChannelId}
            onChange={(e) => setNewChannelId(e.target.value)}
          >
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>
        <div className="server-menu__field">
          <label className="server-menu__label">name</label>
          <input
            className="server-menu__input"
            placeholder="My Bot"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>

        <div className="server-menu__save-row" style={{ marginTop: '8px' }}>
          <button className="server-menu__save-btn" onClick={handleCreate} disabled={loading || !newName.trim()}>
            {loading ? 'creating...' : 'create webhook'}
          </button>
          {error && (
            <span className="server-menu__save-msg server-menu__save-msg--err">{error}</span>
          )}
        </div>
      </div>

      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">active webhooks ({webhooks.length})</p>
        {webhooks.length > 0 ? (
          webhooks.map((wh) => (
            <div key={wh.id} className="server-menu__webhook-item">
              <div className="server-menu__webhook-item-info">
                <span className="server-menu__webhook-item-name">{wh.name}</span>
                <span className="server-menu__webhook-item-channel">
                  #{getChannelName(wh.channel_id)}
                </span>
                <span className="server-menu__webhook-item-date">
                  {new Date(wh.created_at * 1000).toLocaleDateString()}
                </span>
              </div>
              <div className="server-menu__webhook-item-actions">
                <button
                  className={`server-menu__save-btn${copiedId === wh.id ? ' server-menu__save-btn--copied' : ''}`}
                  onClick={() => handleCopy(wh.token, wh.id)}
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                >
                  {copiedId === wh.id ? 'copied!' : 'copy url'}
                </button>
                <button className="server-menu__btn server-menu__btn--danger" onClick={() => handleDelete(wh.id)}>
                  delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="server-menu__loading">no webhooks configured</p>
        )}
      </div>
    </>
  )
}

function LogsSection() {
  const session = useServerStore((s) => s.activeSession)
  const [stats, setStats] = useState<{ attachments: { count: number; totalSize: number }; gifs: { count: number; totalSize: number }; auditLogs: { count: number }; orphans: { count: number; totalSize: number }; dbSize: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionMsg, setActionMsg] = useState('')
  const [clearConfirm, setClearConfirm] = useState(false)
  const [orphanConfirm, setOrphanConfirm] = useState(false)

  const loadStats = useCallback(async () => {
    if (!session) return
    try {
      const s = await fetchStorageStats(session.url)
      setStats(s)
    } catch {} finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => { loadStats() }, [loadStats])

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const handleClearAudit = async () => {
    if (!session) return
    setActionMsg('')
    try {
      await clearAuditLogs(session.url)
      setActionMsg('audit logs cleared')
      setClearConfirm(false)
      loadStats()
    } catch (err) {
      setActionMsg(`error: ${handleApiErr(err)}`)
    }
  }

  const handleCleanupOrphans = async () => {
    if (!session) return
    setActionMsg('')
    try {
      const res = await cleanupOrphanFiles(session.url)
      setActionMsg(`deleted ${res.deletedCount} orphan files (${formatBytes(res.freedBytes)})`)
      setOrphanConfirm(false)
      loadStats()
    } catch (err) {
      setActionMsg(`error: ${handleApiErr(err)}`)
    }
  }

  if (loading) return <p className="server-menu__loading">loading...</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <h3 style={{ margin: 0 }}>logs & data</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: 0 }}>
        Manage server storage and audit logs. Auto-cleanup runs every 6 hours for orphan files and daily for old audit logs.
      </p>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Attachments</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.attachments.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{formatBytes(stats.attachments.totalSize)}</div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>GIFs & Stickers</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.gifs.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{formatBytes(stats.gifs.totalSize)}</div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Audit Logs</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.auditLogs.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>entries</div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Orphaned Files</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.orphans.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{formatBytes(stats.orphans.totalSize)}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
          <span style={{ flex: 1, fontSize: '13px' }}>Clear audit logs ({stats?.auditLogs.count ?? 0} entries)</span>
          {clearConfirm ? (
            <>
              <button className="server-menu__btn server-menu__btn--danger" onClick={handleClearAudit} style={{ padding: '4px 10px', fontSize: '12px' }}>confirm</button>
              <button className="server-menu__btn" onClick={() => setClearConfirm(false)} style={{ padding: '4px 10px', fontSize: '12px' }}>cancel</button>
            </>
          ) : (
            <button className="server-menu__btn server-menu__btn--danger" onClick={() => setClearConfirm(true)} style={{ padding: '4px 10px', fontSize: '12px' }}>clear</button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
          <span style={{ flex: 1, fontSize: '13px' }}>Clean up orphaned files ({stats?.orphans.count ?? 0} files, {stats ? formatBytes(stats.orphans.totalSize) : '0 B'})</span>
          {orphanConfirm ? (
            <>
              <button className="server-menu__btn server-menu__btn--danger" onClick={handleCleanupOrphans} style={{ padding: '4px 10px', fontSize: '12px' }}>confirm</button>
              <button className="server-menu__btn" onClick={() => setOrphanConfirm(false)} style={{ padding: '4px 10px', fontSize: '12px' }}>cancel</button>
            </>
          ) : (
            <button className="server-menu__btn server-menu__btn--danger" onClick={() => setOrphanConfirm(true)} style={{ padding: '4px 10px', fontSize: '12px' }}>clean up</button>
          )}
        </div>
      </div>

      {actionMsg && (
        <p style={{ color: actionMsg.startsWith('error') ? 'var(--error)' : 'var(--success)', fontSize: '13px' }}>{actionMsg}</p>
      )}

      {stats && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Database size: {formatBytes(stats.dbSize)}
        </div>
      )}
    </div>
  )
}

function handleApiErr(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e?.response?.data?.error || e?.message || 'request failed'
}

function fileToDataUrl(file: File, maxSize = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxSize || height > maxSize) {
          if (width > height) { height = Math.round((height / width) * maxSize); width = maxSize }
          else { width = Math.round((width / height) * maxSize); height = maxSize }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

type Section =
  | 'profile'
  | 'notifications'
  | 'overview'
  | 'members'
  | 'invites'
  | 'roles'
  | 'css'
  | 'gifs'
  | 'webhooks'
  | 'logs'

const SECTION_LABELS: Record<Section, string> = {
  profile: 'profile',
  notifications: 'notifications',
  overview: 'overview',
  members: 'members',
  invites: 'invites',
  roles: 'roles',
  css: 'custom css',
  gifs: 'gifs & stickers',
  webhooks: 'webhooks',
  logs: 'logs & data',
}

function NotificationSettings() {
  const session = useServerStore((s) => s.activeSession)
  const settings = useSettingsStore((s) => s.notificationSettings)
  const setNotificationSettings = useSettingsStore((s) => s.setNotificationSettings)
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled)
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled)
  const serverId = session?.serverId || ''
  const current = settings[serverId] || { level: 'all' as const, suppressEveryone: false }

  return (
    <>
      <div className="server-menu__field">
        <label className="server-menu__label">server notification level</label>
        <select
          value={current.level}
          onChange={(e) => setNotificationSettings(serverId, { ...current, level: e.target.value as 'all' | 'mentions' | 'none' })}
          className="server-menu__select"
        >
          <option value="all">All messages</option>
          <option value="mentions">Only @mentions</option>
          <option value="none">Nothing</option>
        </select>
      </div>
      <div className="server-menu__toggle-row">
        <label className="server-menu__label" style={{ margin: 0 }}>suppress @everyone and @here</label>
        <ToggleSwitch
          checked={current.suppressEveryone}
          onChange={(checked) => setNotificationSettings(serverId, { ...current, suppressEveryone: checked })}
          ariaLabel="suppress @everyone and @here"
        />
      </div>
      <div className="server-menu__toggle-row">
        <label className="server-menu__label" style={{ margin: 0 }}>notification sounds</label>
        <ToggleSwitch
          checked={notificationSoundEnabled}
          onChange={setNotificationSoundEnabled}
          ariaLabel="notification sounds"
        />
      </div>
    </>
  )
}

export default function ServerMenuModal({ onClose, onBackgroundChanged }: Props) {
  const { activeSession: session, updateServerInfo, servers } = useServerStore()
  const serverUrl = session?.url
  const isAdmin = session?.user?.role === 'admin'
  const mountedRef = useRef(false)
  mountedRef.current = true
  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  const navigate = useNavigate()
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteAllData, setDeleteAllData] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDeleteAccount = useCallback(async () => {
    if (!serverUrl || !deletePassword) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteAccount(serverUrl, deletePassword, deleteAllData)
      useServerStore.getState().setActiveSession(null)
      onClose()
      navigate('/')
    } catch (err: unknown) {
      const msg = handleApiErr(err)
      if (msg.includes('401') || msg.includes('Invalid password')) {
        setDeleteError('Incorrect password')
      } else {
        setDeleteError(msg)
      }
    } finally {
      setDeleting(false)
    }
  }, [serverUrl, deletePassword, deleteAllData, onClose, navigate])

  // ─── Profile ─────────────────────────────────────────
  const [displayName, setDisplayName] = useState(session?.user?.display_name ?? '')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(session?.user?.avatar ?? null)
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState<string | null>(null)
  const profileFileRef = useRef<HTMLInputElement>(null)
  const pendingAvatarFile = useRef<File | null>(null)
  const [bannerPreview, setBannerPreview] = useState<string | null>(session?.user?.banner ?? null)
  const [bannerChanged, setBannerChanged] = useState(false)
  const bannerFileRef = useRef<HTMLInputElement>(null)
  const pendingBannerFile = useRef<File | null>(null)

  // ─── Active settings section (left-nav selection) ────
  const [section, setSection] = useState<Section>('profile')

  // Selector hooks must run on every render (not inside a section branch),
  // otherwise switching tabs changes the hook count and React throws.
  const serverBackgroundEnabled = useSettingsStore(s => s.serverBackgroundEnabled)
  const customCssEnabled = useSettingsStore(s => s.customCssEnabled)

  // ─── Server settings ─────────────────────────────────
  const [serverName, setServerName] = useState(session ? servers.find(s => s.id === session.serverId)?.name ?? '' : '')
  const [serverIconPreview, setServerIconPreview] = useState<string | null>(
    session ? servers.find(s => s.id === session.serverId)?.icon ?? null : null,
  )
  const [serverIconChanged, setServerIconChanged] = useState(false)
  const [serverSaving, setServerSaving] = useState(false)
  const [serverMsg, setServerMsg] = useState<string | null>(null)
  const serverIconFileRef = useRef<HTMLInputElement>(null)
  const pendingServerIconFile = useRef<File | null>(null)

  // ─── Background ──────────────────────────────────────
  const [bgHasImage, setBgHasImage] = useState(false)
  const [bgBlur, setBgBlur] = useState(0)
  const [bgPreviewTs, setBgPreviewTs] = useState(Date.now())
  const [bgUploading, setBgUploading] = useState(false)
  const bgFileRef = useRef<HTMLInputElement>(null)

  const [customCss, setCustomCss] = useState('')
  const [customCssSaving, setCustomCssSaving] = useState(false)
  const [customCssMsg, setCustomCssMsg] = useState<string | null>(null)
  const [voiceBitrateKbps, setVoiceBitrateKbps] = useState(64)
  const [infoLoading, setInfoLoading] = useState(false)

  const serverIconDisplay = serverIconPreview

  const bgPreviewUrl = serverUrl && bgHasImage ? `${serverUrl}/api/server/background?t=${bgPreviewTs}` : null

  useEffect(() => {
    if (!serverUrl) { setInfoLoading(false); return }

    const delay = setTimeout(() => { if (mountedRef.current) setInfoLoading(true) }, 300)

    fetchServerInfo(serverUrl).then(info => {
      if (!mountedRef.current) return
      clearTimeout(delay)
      setBgHasImage(info.hasBackground)
      setBgBlur(info.backgroundBlur)
      setCustomCss(info.customCss || '')
      setVoiceBitrateKbps(info.voiceBitrateKbps ?? 64)
      setInfoLoading(false)
    }).catch((err) => {
      console.error('Failed to fetch server info:', err)
      if (mountedRef.current) {
        clearTimeout(delay)
        setInfoLoading(false)
      }
    })

    return () => clearTimeout(delay)
  }, [serverUrl])

  useEffect(() => {
    const previewEl = document.getElementById('kizuna-custom-css-preview') as HTMLStyleElement | null
    if (section === 'css' && customCss) {
      if (previewEl) {
        previewEl.textContent = customCss
      } else {
        const style = document.createElement('style')
        style.id = 'kizuna-custom-css-preview'
        style.textContent = customCss
        document.head.appendChild(style)
      }
    } else if (previewEl) {
      previewEl.remove()
    }
    return () => {
      const el = document.getElementById('kizuna-custom-css-preview')
      if (el) el.remove()
    }
  }, [section, customCss])

  // auto-save voice bitrate on change (ref-based so it survives modal close)
  const voiceBitrateSaveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const saveVoiceBitrate = useCallback((kbps: number) => {
    clearTimeout(voiceBitrateSaveTimerRef.current)
    voiceBitrateSaveTimerRef.current = setTimeout(async () => {
      const { activeSession } = useServerStore.getState()
      const url = activeSession?.url
      if (!url) return
      try {
        await updateServerSettings(url, undefined, undefined, undefined, undefined, kbps)
      } catch (err) {
        console.error('Failed to save voice bitrate:', err)
        const { activeSession } = useServerStore.getState()
        if (activeSession) setServerMsg(handleApiErr(err))
      }
    }, 300)
  }, [])

  // auto-save background blur on change (ref-based so it survives modal close)
  const bgBlurSaveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const saveBgBlur = useCallback((blur: number) => {
    clearTimeout(bgBlurSaveTimerRef.current)
    bgBlurSaveTimerRef.current = setTimeout(async () => {
      const url = useServerStore.getState().activeSession?.url
      if (!url) return
      try {
        await updateServerSettings(url, undefined, undefined, blur)
        onBackgroundChanged?.()
      } catch (err) {
        console.error('Failed to save background blur:', err)
        setServerMsg(handleApiErr(err))
      }
    }, 400)
  }, [onBackgroundChanged])

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

  const handleBannerFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setProfileMsg(null)
    pendingBannerFile.current = file
    const url = URL.createObjectURL(file)
    setBannerPreview(url)
    setBannerChanged(true)
    e.target.value = ''
  }

  const handleSaveProfile = async () => {
    if (!serverUrl || !session) return
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
      let bannerPayload: string | null | undefined = undefined
      if (bannerChanged) {
        if (bannerPreview === null) {
          bannerPayload = null
          pendingBannerFile.current = null
        } else if (pendingBannerFile.current) {
          bannerPayload = await fileToDataUrl(pendingBannerFile.current, 800)
        }
      }
      const updated = await updateProfile(serverUrl, displayName, avatarPayload, bannerPayload)
      useServerStore.getState().setActiveSession({ ...session, user: updated })
      useServerStore.getState().updateServerInfo(session.serverId, { name: updated.display_name })
      setAvatarChanged(false)
      pendingAvatarFile.current = null
      setBannerChanged(false)
      pendingBannerFile.current = null
      setProfileMsg('saved')
      setTimeout(() => setProfileMsg(null), 3000)
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
    if (!serverUrl || !session) return
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
      const res = await updateServerSettings(serverUrl, serverName, iconPayload, bgBlur, undefined, voiceBitrateKbps)
      updateServerInfo(session.serverId, { name: res.name, icon: res.icon ?? undefined })
      setServerIconChanged(false)
      setServerIconPreview(res.icon ?? null)
      pendingServerIconFile.current = null
      setServerMsg('saved')
      setTimeout(() => setServerMsg(null), 3000)
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
    setServerSaving(false)
  }

  const handleSaveCustomCss = async () => {
    if (!serverUrl || !session) return
    setCustomCssSaving(true)
    setCustomCssMsg(null)
    try {
      const cssValue = customCss.trim() || null
      await updateServerSettings(serverUrl, undefined, undefined, undefined, cssValue)
      if (cssValue) {
        setCustomCss(cssValue)
      }
      onBackgroundChanged?.()
      setCustomCssMsg('saved')
      setTimeout(() => setCustomCssMsg(null), 3000)
    } catch (err) {
      setCustomCssMsg(handleApiErr(err))
    }
    setCustomCssSaving(false)
  }

  // ─── Background handlers ────────────────────────────
  const handleBgFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    setServerMsg(null)
    setBgUploading(true)
    try {
      await uploadServerBackground(serverUrl, file)
      setBgHasImage(true)
      setBgPreviewTs(Date.now())
      onBackgroundChanged?.()
      setServerMsg('background uploaded')
      setTimeout(() => setServerMsg(null), 3000)
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
    setBgUploading(false)
    e.target.value = ''
  }

  const handleRemoveBg = async () => {
    if (!serverUrl) return
    setServerMsg(null)
    try {
      await deleteServerBackground(serverUrl)
      setBgHasImage(false)
      setBgPreviewTs(Date.now())
      onBackgroundChanged?.()
      setServerMsg('background removed')
      setTimeout(() => setServerMsg(null), 3000)
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
  }

  // Left-nav groups: the "user" group is always shown; the "admin" group only
  // appears for admins. Item keys map 1:1 to the `section` union.
  const navGroups = useMemo<SettingsNavGroup[]>(() => {
    const groups: SettingsNavGroup[] = [
      {
        label: 'user',
        items: [
          { key: 'profile', label: 'profile', icon: <User size={15} /> },
          { key: 'notifications', label: 'notifications', icon: <Bell size={15} /> },
        ],
      },
    ]
    if (isAdmin) {
      groups.push({
        label: 'admin',
        items: [
          { key: 'overview', label: 'overview', icon: <SlidersHorizontal size={15} /> },
          { key: 'members', label: 'members', icon: <Users size={15} /> },
          { key: 'invites', label: 'invites', icon: <Link2 size={15} /> },
          { key: 'roles', label: 'roles', icon: <Shield size={15} /> },
          { key: 'css', label: 'custom css', icon: <Code size={15} /> },
          { key: 'gifs', label: 'gifs & stickers', icon: <ImageIcon size={15} /> },
          { key: 'webhooks', label: 'webhooks', icon: <Link2 size={15} /> },
          { key: 'logs', label: 'logs & data', icon: <Trash2 size={15} /> },
        ],
      })
    }
    return groups
  }, [isAdmin])

  const handleSectionChange = useCallback((key: string) => {
    setSection(key as Section)
  }, [])

  return (
    <>
    <Modal
      open
      onClose={onClose}
      title="// server menu"
      className="server-menu"
      footer={(handleClose) => (
        <button onClick={handleClose} className="server-menu__done-btn">done</button>
      )}
    >
      <SettingsLayout
        groups={navGroups}
        activeKey={section}
        onChange={handleSectionChange}
        activeLabel={SECTION_LABELS[section]}
      >
        {/* Profile */}
        {section === 'profile' && (
        <section className="server-menu__section">

            <div className="server-menu__profile-preview">
              <div className="server-menu__profile-banner" onClick={() => bannerFileRef.current?.click()} title="change banner">
                {bannerPreview ? (
                  <img src={bannerPreview} alt="" className="server-menu__profile-banner-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                ) : (
                  <div className="server-menu__profile-banner-empty" />
                )}
                <div className="server-menu__profile-banner-overlay">
                  <span>{bannerPreview ? 'change banner' : 'add banner'}</span>
                </div>
              </div>

              <div className="server-menu__profile-avatar-wrap">
                <div className="server-menu__profile-avatar" onClick={() => profileFileRef.current?.click()} title="change avatar">
                  <span className="server-menu__profile-avatar-letter">{(displayName || session?.user?.display_name || '?')[0]?.toUpperCase()}</span>
                  {avatarPreview && (
                    <img src={avatarPreview} alt="" className="server-menu__profile-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  )}
                  <div className="server-menu__profile-avatar-overlay">
                    <span>+</span>
                  </div>
                </div>
              </div>

              <div className="server-menu__profile-actions">
                <button onClick={() => profileFileRef.current?.click()} className="server-menu__profile-action">avatar</button>
                {avatarPreview && (
                  <button onClick={() => { pendingAvatarFile.current = null; setAvatarPreview(null); setAvatarChanged(true) }} className="server-menu__profile-action server-menu__profile-action--remove">clear avatar</button>
                )}
                <button onClick={() => bannerFileRef.current?.click()} className="server-menu__profile-action">{bannerPreview ? 'banner' : 'set banner'}</button>
                {bannerPreview && (
                  <button onClick={() => { pendingBannerFile.current = null; setBannerPreview(null); setBannerChanged(true) }} className="server-menu__profile-action server-menu__profile-action--remove">clear</button>
                )}
              </div>
            </div>

            <input ref={profileFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
            <input ref={bannerFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBannerFile} />

            <div className="server-menu__settings-group" style={{ marginTop: '16px' }}>
              <p className="server-menu__settings-group-title">identity</p>
              <div className="server-menu__field">
                <label className="server-menu__label">display name</label>
                <input className="server-menu__input" maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="display name" />
              </div>
            </div>

            <div className="server-menu__settings-group">
              <p className="server-menu__settings-group-title">display</p>
              <div className="server-menu__toggle-row" style={{ marginTop: 0 }}>
                <label className="server-menu__label" style={{ margin: 0 }}>show server background</label>
                <ToggleSwitch
                  checked={serverBackgroundEnabled}
                  onChange={(checked) => useSettingsStore.getState().setServerBackgroundEnabled(checked)}
                  ariaLabel="show server background"
                />
              </div>
              <div className="server-menu__toggle-row">
                <label className="server-menu__label" style={{ margin: 0 }}>enable custom css</label>
                <ToggleSwitch
                  checked={customCssEnabled}
                  onChange={(checked) => useSettingsStore.getState().setCustomCssEnabled(checked)}
                  ariaLabel="enable custom css"
                />
              </div>
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

            <div className="server-menu__settings-group" style={{ marginTop: '16px' }}>
              <p className="server-menu__settings-group-title">danger zone</p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <p className="server-menu__hint" style={{ margin: 0 }}>permanently remove your account from this server.</p>
                <button onClick={() => { setDeleteConfirm(true); setDeleteAllData(false); setDeletePassword(''); setDeleteError('') }} className="server-menu__btn server-menu__btn--danger">
                  delete account
                </button>
              </div>
            </div>
          </section>
        )}

          {/* Notifications */}
          {section === 'notifications' && (
          <section className="server-menu__section">
            <div className="server-menu__settings-group">
              <p className="server-menu__settings-group-title">notifications</p>
              <NotificationSettings />
            </div>
          </section>
          )}

              {/* Overview (server settings) */}
              {section === 'overview' && (
                <div className="server-menu__section">
                  {infoLoading && <p className="server-menu__info-loading">loading server info...</p>}

                  {/* Identity */}
                  <div className="server-menu__settings-group">
                    <p className="server-menu__settings-group-title">identity</p>
                    <div className="server-menu__avatar-row">
                      <div className="server-menu__avatar" onClick={() => serverIconFileRef.current?.click()} title="click to change server icon">
                        <span>{(serverName || '?').slice(0, 2).toUpperCase()}</span>
                        {serverIconDisplay && (
                          <img src={serverIconDisplay} alt="" className="server-menu__avatar-img"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                        )}
                      </div>
                      <div className="server-menu__avatar-actions">
                        <button onClick={() => serverIconFileRef.current?.click()} className="server-menu__upload-btn">upload icon</button>
                        {(serverIconPreview) && (
                          <button onClick={() => { pendingServerIconFile.current = null; setServerIconPreview(null); setServerIconChanged(true) }}
                            className="server-menu__remove-btn">remove icon</button>
                        )}
                      </div>
                      <input ref={serverIconFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleServerIconFile} />
                    </div>
                    <div className="server-menu__field" style={{ marginTop: '10px' }}>
                      <label className="server-menu__label">server name</label>
                      <input className="server-menu__input" maxLength={100} value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="server name" />
                    </div>
                  </div>

                  {/* Appearance */}
                  <div className="server-menu__settings-group">
                    <p className="server-menu__settings-group-title">appearance</p>
                    <div className="server-menu__field">
                      <label className="server-menu__label">background image</label>
                      <div className="server-menu__bg-row">
                        <div
                          className={`server-menu__bg-preview${!bgPreviewUrl ? ' server-menu__bg-preview--empty' : ''}`}
                          style={bgPreviewUrl ? { backgroundImage: `url(${bgPreviewUrl})` } : undefined}
                        >
                          {!bgPreviewUrl && <span className="server-menu__bg-preview-placeholder">no image</span>}
                        </div>
                        <div className="server-menu__bg-actions">
                          <button onClick={() => bgFileRef.current?.click()} disabled={bgUploading} className="server-menu__upload-btn">
                            {bgUploading ? 'uploading...' : bgHasImage ? 'change' : 'upload background'}
                          </button>
                          {bgHasImage && (
                            <button onClick={handleRemoveBg} className="server-menu__remove-btn">remove</button>
                          )}
                        </div>
                        <input ref={bgFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgFile} />
                      </div>
                    </div>
                    <div className="server-menu__field" style={{ marginTop: '10px' }}>
                      <div className="server-menu__label-row">
                        <label className="server-menu__label">background blur</label>
                        <span className="server-menu__value-chip">{bgBlur}px</span>
                      </div>
                      <Slider min={0} max={20} value={bgBlur} onChange={(v) => { setBgBlur(v); saveBgBlur(v) }} ariaLabel="Background blur" />
                    </div>
                  </div>

                  {/* Voice */}
                  <div className="server-menu__settings-group">
                    <p className="server-menu__settings-group-title">voice</p>
                    <div className="server-menu__field">
                      <label className="server-menu__label">bitrate</label>
                      <select
                        value={voiceBitrateKbps}
                        onChange={(e) => { const kbps = Number(e.target.value); setVoiceBitrateKbps(kbps); saveVoiceBitrate(kbps) }}
                        className="server-menu__select"
                      >
                        <option value={32}>32 kbps — low bandwidth</option>
                        <option value={64}>64 kbps — balanced</option>
                        <option value={96}>96 kbps</option>
                        <option value={128}>128 kbps — high quality</option>
                        <option value={192}>192 kbps</option>
                        <option value={256}>256 kbps</option>
                        <option value={320}>320 kbps — max quality</option>
                      </select>
                      <p className="server-menu__hint">applies immediately to all connected users</p>
                    </div>
                  </div>

                  <div className="server-menu__save-row">
                    <button onClick={handleSaveServer} disabled={serverSaving} className="server-menu__save-btn">
                      {serverSaving ? 'saving...' : 'save settings'}
                    </button>
                    {serverMsg && (
                      <span className={`server-menu__save-msg ${serverMsg === 'saved' || serverMsg.startsWith('background') ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
                        {serverMsg}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Members tab */}
              {section === 'members' && <MembersSection serverUrl={serverUrl} />}

              {/* Invites tab */}
              {section === 'invites' && <InvitesSection serverUrl={serverUrl} />}

              {/* Roles tab */}
              {section === 'roles' && <RolesSection serverUrl={serverUrl} />}

              {/* Custom CSS tab */}
              {section === 'css' && (
                <section className="server-menu__section--grow">
                  <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
                    Override CSS variables to theme your server. Changes preview live.
                  </p>
                  <div className="server-menu__css-body">
                    <textarea
                      className="server-menu__css-editor"
                      value={customCss}
                      onChange={(e) => setCustomCss(e.target.value.slice(0, 50000))}
                      maxLength={50000}
                      placeholder={`/* Kizuna Custom CSS — override any variable below */\n:root {\n  /* Backgrounds */\n  --bg-primary: #0a0a0a;\n  --bg-secondary: #111111;\n  --bg-tertiary: #1a1a1a;\n  --bg-hover: #262626;\n  --bg-active: #2d2d2d;\n\n  /* Text */\n  --text-primary: #ffffff;\n  --text-secondary: #a0a0a0;\n  --text-muted: #6b6b6b;\n\n  /* Borders */\n  --border-color: #2a2a2a;\n\n  /* Brand / Accent */\n  --brand: #4c6ef5;\n  --brand-hover: #4263eb;\n  --brand-dim: rgba(76, 110, 245, 0.15);\n  --accent-color: #6366f1;\n\n  /* Semantic colors */\n  --red: #ff4d4d;\n  --red-hover: #ff3333;\n  --red-dim: rgba(255, 77, 77, 0.15);\n  --red-dim-border: rgba(255, 77, 77, 0.30);\n  --green: #40c057;\n  --green-dim: rgba(64, 192, 87, 0.15);\n  --green-dim-border: rgba(64, 192, 87, 0.20);\n  --yellow: #fab005;\n\n  /* Border radius */\n  --radius-sm: 8px;\n  --radius-md: 12px;\n  --radius-lg: 16px;\n  --radius-xl: 24px;\n  --radius-full: 9999px;\n\n  /* Font */\n  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;\n}`}
                      spellCheck={false}
                    />
                    <div className="server-menu__save-row" style={{ marginTop: 0 }}>
                      <button onClick={handleSaveCustomCss} disabled={customCssSaving || customCss.length > 50000} className="server-menu__save-btn">
                        {customCssSaving ? '...' : 'save css'}
                      </button>
                      <span className={`server-menu__css-char-count${customCss.length > 45000 ? ' server-menu__css-char-count--warn' : ''}${customCss.length >= 50000 ? ' server-menu__css-char-count--over' : ''}`}>
                        {customCss.length.toLocaleString()} / 50,000
                      </span>
                      {customCssMsg && (
                        <span className={`server-menu__save-msg ${customCssMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
                          {customCssMsg}
                        </span>
                      )}
                    </div>
                  </div>
                </section>
              )}

              {/* GIFs & Stickers tab */}
              {section === 'gifs' && <GifsSection serverUrl={serverUrl} />}

              {/* Webhooks */}
              {section === 'webhooks' && (
                <div className="server-menu__section">
                  <WebhooksSection />
                </div>
              )}

              {/* Logs & Data */}
              {section === 'logs' && (
                <div className="server-menu__section">
                  <LogsSection />
                </div>
              )}
      </SettingsLayout>
    </Modal>


    <Modal
      open={deleteConfirm}
      onClose={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteAllData(false); setDeleteError('') }}
      title="// delete account"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            className="server-menu__confirm-cancel"
            onClick={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteAllData(false); setDeleteError('') }}
            disabled={deleting}
          >
                cancel
          </button>
          <button
            onClick={handleDeleteAccount}
            disabled={deleting || !deletePassword}
            className="server-menu__btn server-menu__btn--danger"
          >
            {deleting ? 'deleting...' : 'delete account'}
          </button>
        </div>
      }
    >
      <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '16px' }}>
        your account will be permanently removed. your public messages remain visible to others
        unless you choose to delete all data below.
      </p>
      <Checkbox
        checked={deleteAllData}
        onChange={setDeleteAllData}
                    label="also delete all my data"
      />
      <div style={{ marginTop: '16px' }}>
        <label className="server-menu__label" style={{ marginBottom: '6px' }}>enter your password to confirm</label>
        <input
          type="password"
          className="server-menu__input"
          placeholder="your password"
          value={deletePassword}
          onChange={(e) => setDeletePassword(e.target.value)}
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') handleDeleteAccount() }}
        />
      </div>
      {deleteError && (
        <span className="server-menu__save-msg server-menu__save-msg--err" style={{ display: 'block', marginTop: '8px' }}>{deleteError}</span>
      )}
    </Modal>

    </>
  )
}
