import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  MoreHorizontal, Pencil, X,
  User, Bell, SlidersHorizontal, Users, Link2, Shield, Code, Image as ImageIcon, Trash2,
} from 'lucide-react'
import Modal from './ui/Modal'
import Tabs from './ui/Tabs'
import SettingsLayout, { type SettingsNavGroup } from './ui/SettingsLayout'
import ToggleSwitch from './ui/ToggleSwitch'
import Slider from './ui/Slider'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useSettingsStore } from '../store/settingsStore'
import QRCode from 'qrcode'
import {
  updateProfile,
  updateServerSettings,
  fetchMembers,
  createInvite,
  fetchInvites,
  revokeInvite,
  setMemberRole,
  kickMember,
  addMemberRole,
  removeMemberRole,
  fetchRoles,
  createRole,
  updateRole,
  deleteRole,
  reorderRoles,
  uploadServerBackground,
  deleteServerBackground,
  fetchServerInfo,
  generatePasswordReset,
  uploadGif,
  uploadGifPack,
  uploadStickerPack,
  uploadSticker,
  fetchGifs,
  deleteGif,
  deleteStickerPack,
  updateGif,
  generateGifTags,
  loadTagger,
  unloadTagger,
  getTaggerStatus,
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
  fetchStorageStats,
  clearAuditLogs,
  cleanupOrphanFiles,
} from '@kizuna/shared'
import type { Member, CustomRole, Permission, UserStatus, GifInfo, TaggerStatus, InviteCode } from '@kizuna/shared'
import { hexToRgba } from '../utils/color'
import './ServerMenuModal.css'

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

const GIF_TABS: { key: 'gif' | 'sticker'; label: string }[] = [
  { key: 'gif', label: 'gif' },
  { key: 'sticker', label: 'sticker' },
]

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

const EXPIRY_OPTIONS = [
  { label: 'never', value: '0' },
  { label: '1 hour', value: '1' },
  { label: '6 hours', value: '6' },
  { label: '1 day', value: '24' },
  { label: '7 days', value: '168' },
  { label: '30 days', value: '720' },
]

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
  const { members, setMembers } = useChatStore()
  const { userStatuses } = useVoiceStore()
  const serverUrl = session?.url
  const isAdmin = session?.user?.role === 'admin'
  const mountedRef = useRef(false)
  mountedRef.current = true
  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

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

  // ─── Members ─────────────────────────────────────────
  const [membersLoading, setMembersLoading] = useState(false)
  const [memberMsg, setMemberMsg] = useState<Record<string, string>>({})
  const [resetTokenData, setResetTokenData] = useState<{ userId: string; token: string; username: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set())
  const [openOverflowMember, setOpenOverflowMember] = useState<string | null>(null)
  const [kickConfirmMember, setKickConfirmMember] = useState<string | null>(null)
  const [selfDemoteConfirm, setSelfDemoteConfirm] = useState(false)
  const overflowRef = useRef<HTMLDivElement | null>(null)

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

  // ─── Invites ─────────────────────────────────────────
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [newMaxUses, setNewMaxUses] = useState('')
  const [newExpiry, setNewExpiry] = useState('0')
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [activeQr, setActiveQr] = useState<{ code: string; dataUrl: string } | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  // ─── Roles ───────────────────────────────────────────
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
  const [assigningRole, setAssigningRole] = useState<Record<string, boolean>>({})
  const [showCreateRole, setShowCreateRole] = useState(false)
  const [reorderingRoles, setReorderingRoles] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)

  // ─── GIFs & Stickers ────────────────────────────────
  const [gifsList, setGifsList] = useState<GifInfo[]>([])
  const [gifsLoading, setGifsLoading] = useState(false)
  const [taggerStatus, setTaggerStatus] = useState<TaggerStatus>({ loaded: false, loading: false, enabled: false })
  const [taggerLoading, setTaggerLoading] = useState(false)
  const [showTaggerWarning, setShowTaggerWarning] = useState(false)
  const [gifUploading, setGifUploading] = useState(false)
  const [gifMsg, setGifMsg] = useState<string | null>(null)
  const [gifTab, setGifTab] = useState<'gif' | 'sticker'>('gif')
  const [gifName, setGifName] = useState('')
  const [gifCategory, setGifCategory] = useState('')
  const [gifTags, setGifTags] = useState('')
  const [editingGifId, setEditingGifId] = useState<string | null>(null)
  const [gifEditName, setGifEditName] = useState('')
  const [gifEditCategory, setGifEditCategory] = useState('')
  const [gifEditTags, setGifEditTags] = useState('')
  const [generatingTags, setGeneratingTags] = useState<Set<string>>(new Set())
  const gifFileRef = useRef<HTMLInputElement>(null)
  const gifPackFileRef = useRef<HTMLInputElement>(null)
  const stickerPackFileRef = useRef<HTMLInputElement>(null)
  const singleStickerFileRef = useRef<HTMLInputElement>(null)
  // Styled popup for naming a sticker pack when importing a .zip (replaces window.prompt)
  const [packNameModal, setPackNameModal] = useState<{ open: boolean; file: File | null; name: string }>(
    { open: false, file: null, name: '' },
  )
  // Styled popup for uploading a single sticker into an existing or new pack
  const [stickerUpload, setStickerUpload] = useState<{
    open: boolean
    file: File | null
    selectedPack: string // '' means "create a new pack"
    newPackName: string
    displayName: string
    uploading: boolean
  }>({ open: false, file: null, selectedPack: '', newPackName: '', displayName: '', uploading: false })

  function memberRoleCount(roleId: string): number {
    return members.filter(m => (m.custom_roles || []).some(r => r.id === roleId)).length
  }

  useEffect(() => {
    if (!isAdmin || !serverUrl) return
    if (section === 'members') {
      setMembersLoading(true)
      fetchMembers(serverUrl).then(d => { if (mountedRef.current) setMembers(d) }).catch(console.error).finally(() => { if (mountedRef.current) setMembersLoading(false) })
      loadRoles()
    } else if (section === 'invites') {
      loadInvites()
    } else if (section === 'roles') {
      loadRoles()
    } else if (section === 'gifs') {
      loadGifs()
      loadTaggerStatus()
    }
  }, [section, isAdmin, serverUrl])

  async function loadInvites() {
    if (!serverUrl) return
    setInvitesLoading(true)
    try { if (mountedRef.current) setInvites(await fetchInvites(serverUrl)) } catch (err) {
      console.error('Failed to fetch invites:', err)
    }
    if (mountedRef.current) setInvitesLoading(false)
  }

  async function loadRoles() {
    if (!serverUrl) return
    setRolesLoading(true)
    try { if (mountedRef.current) setRoles(await fetchRoles(serverUrl)) } catch (err) {
      console.error('Failed to fetch roles:', err)
    }
    if (mountedRef.current) setRolesLoading(false)
  }

  async function loadGifs() {
    if (!serverUrl) return
    setGifsLoading(true)
    try {
      const gifs = await fetchGifs(serverUrl, { limit: 200 })
      if (mountedRef.current) setGifsList(gifs)
    } catch (err) {
      console.error('Failed to fetch gifs:', err)
    }
    if (mountedRef.current) setGifsLoading(false)
  }

  async function loadTaggerStatus() {
    if (!serverUrl) return
    try {
      const status = await getTaggerStatus(serverUrl)
      if (mountedRef.current) setTaggerStatus(status)
    } catch {
      // ignore — server might not have tagging or the endpoint yet
    }
  }

  async function handleLoadTagger() {
    if (!serverUrl) return
    setShowTaggerWarning(false)
    setTaggerLoading(true)
    try {
      await loadTagger(serverUrl)
      if (mountedRef.current) setTaggerStatus({ loaded: true, loading: false, enabled: true })
    } catch (err) {
      setGifMsg(handleApiErr(err))
      if (mountedRef.current) setTaggerStatus({ loaded: false, loading: false, enabled: true })
    } finally {
      if (mountedRef.current) setTaggerLoading(false)
    }
  }

  async function handleUnloadTagger() {
    if (!serverUrl) return
    try {
      await unloadTagger(serverUrl)
      if (mountedRef.current) setTaggerStatus({ loaded: false, loading: false, enabled: true })
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
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

  // ─── Member handlers ────────────────────────────────
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
      setMemberMsg(prev => ({ ...prev, [m.id]: `role \u2192 ${newRole}` }))
      setTimeout(() => setMemberMsg(prev => { const n = { ...prev }; delete n[m.id]; return n }), 2000)
    } catch (err) {
      setMemberMsg(prev => ({ ...prev, [m.id]: handleApiErr(err) }))
    }
  }

  const handleKick = async (m: Member) => {
    if (!serverUrl) return
    try {
      await kickMember(serverUrl, m.id)
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

  // ─── Bulk member handlers ───────────────────────────
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
    for (const m of targets) {
      try {
        await kickMember(serverUrl, m.id)
      } catch (err) {
        console.error('Bulk kick failed for member:', m.id, err)
      }
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

  // ─── Invite handlers ────────────────────────────────
  const handleCreateInvite = async () => {
    if (!serverUrl) return
    setCreatingInvite(true)
    try {
      const maxUses = newMaxUses ? parseInt(newMaxUses, 10) : undefined
      const expiresInHours = newExpiry !== '0' ? parseFloat(newExpiry) : undefined
      const invite = await createInvite(serverUrl, maxUses, expiresInHours)
      setInvites(prev => [invite, ...prev])
      const deepLink = `kizuna://join?server=${encodeURIComponent(serverUrl)}&code=${invite.code}`
      const qrDataUrl = await QRCode.toDataURL(deepLink, {
        width: 200,
        margin: 2,
        color: { dark: '#f2f3f5', light: '#1e1f22' },
      })
      setActiveQr({ code: invite.code, dataUrl: qrDataUrl })
      setNewMaxUses('')
      setNewExpiry('0')
      setInviteError(null)
    } catch (err) {
      console.error('Failed to create invite:', err)
      setInviteError(handleApiErr(err))
    }
    setCreatingInvite(false)
  }

  const handleShowQr = async (invite: InviteCode) => {
    if (activeQr?.code === invite.code) {
      setActiveQr(null)
      return
    }
    const deepLink = `kizuna://join?server=${encodeURIComponent(serverUrl!)}&code=${invite.code}`
    const qrDataUrl = await QRCode.toDataURL(deepLink, {
      width: 200,
      margin: 2,
      color: { dark: '#f2f3f5', light: '#1e1f22' },
    })
    setActiveQr({ code: invite.code, dataUrl: qrDataUrl })
  }

  const handleRevokeInvite = async (code: string) => {
    if (!serverUrl) return
    try {
      await revokeInvite(serverUrl, code)
      setInvites(prev => prev.filter(i => i.code !== code))
    } catch (err) {
      console.error('Failed to revoke invite:', err)
      setInviteError(handleApiErr(err))
    }
  }

  // ─── Role handlers ──────────────────────────────────
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

  // ─── GIF/sticker handlers ───────────────────────────
  const handleGifFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    const name = gifName.trim() || file.name.replace(/\.[^.]+$/, '')
    setGifUploading(true)
    setGifMsg(null)
    try {
      await uploadGif(serverUrl, file, name, gifCategory.trim() || undefined, gifTags.trim() || undefined)
      setGifMsg('uploaded')
      setGifName('')
      setGifCategory('')
      setGifTags('')
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
    e.target.value = ''
  }

  const handleGifPackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    setGifUploading(true)
    setGifMsg(null)
    try {
      const result = await uploadGifPack(serverUrl, file)
      setGifMsg(`imported ${result.imported} GIFs`)
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
    e.target.value = ''
  }

  const handleStickerPackFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    setPackNameModal({ open: true, file, name: '' })
    e.target.value = ''
  }

  const confirmStickerPackUpload = async () => {
    const { file, name } = packNameModal
    if (!file || !serverUrl || !name.trim()) return
    setGifUploading(true)
    setGifMsg(null)
    try {
      const result = await uploadStickerPack(serverUrl, file, name.trim())
      setGifMsg(`imported ${result.imported} stickers`)
      loadGifs()
      setPackNameModal({ open: false, file: null, name: '' })
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
  }

  const openStickerUpload = (pack?: string) => {
    setStickerUpload({
      open: true,
      file: null,
      selectedPack: pack ?? '',
      newPackName: '',
      displayName: '',
      uploading: false,
    })
  }

  const confirmStickerUpload = async () => {
    if (!serverUrl) return
    const packName = (stickerUpload.selectedPack || stickerUpload.newPackName).trim()
    if (!stickerUpload.file || !packName) return
    setStickerUpload((s) => ({ ...s, uploading: true }))
    setGifMsg(null)
    try {
      await uploadSticker(
        serverUrl,
        stickerUpload.file,
        packName,
        stickerUpload.displayName.trim() || undefined,
      )
      setGifMsg('uploaded')
      loadGifs()
      setStickerUpload({ open: false, file: null, selectedPack: '', newPackName: '', displayName: '', uploading: false })
    } catch (err) {
      setGifMsg(handleApiErr(err))
      setStickerUpload((s) => ({ ...s, uploading: false }))
    }
  }

  const handleDeleteGif = async (id: string) => {
    if (!serverUrl) return
    try {
      await deleteGif(serverUrl, id)
      setGifsList(prev => prev.filter(g => g.id !== id))
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleStartEdit = (gif: GifInfo) => {
    setEditingGifId(gif.id)
    setGifEditName(gif.display_name)
    setGifEditCategory(gif.category)
    setGifEditTags(gif.tags)
  }

  const handleCancelEdit = () => {
    setEditingGifId(null)
    setGifEditName('')
    setGifEditCategory('')
    setGifEditTags('')
  }

  const handleSaveEdit = async () => {
    if (!serverUrl || !editingGifId) return
    const name = gifEditName.trim()
    if (!name) return
    try {
      await updateGif(serverUrl, editingGifId, {
        display_name: name,
        category: gifEditCategory.trim() || undefined,
        tags: gifEditTags.trim() || undefined,
      })
      setEditingGifId(null)
      setGifEditName('')
      setGifEditCategory('')
      setGifEditTags('')
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleGenerateTags = async (gifId: string) => {
    if (!serverUrl) return
    setGeneratingTags(prev => new Set(prev).add(gifId))
    try {
      const updated = await generateGifTags(serverUrl, gifId)
      setGifsList(prev => prev.map(g => g.id === gifId ? updated : g))
    } catch (err) {
      setGifMsg(handleApiErr(err))
    } finally {
      setGeneratingTags(prev => {
        const next = new Set(prev)
        next.delete(gifId)
        return next
      })
    }
  }

  const handleAcceptSuggestedTag = (gif: GifInfo, tag: string) => {
    const existing = gifEditTags.split(',').map(t => t.trim()).filter(Boolean)
    if (existing.includes(tag)) return
    setGifEditTags([...existing, tag].join(', '))
  }

  const handleDismissSuggestedTags = async (gifId: string) => {
    if (!serverUrl) return
    try {
      const updated = await updateGif(serverUrl, gifId, { suggested_tags: '' })
      setGifsList(prev => prev.map(g => g.id === gifId ? updated : g))
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleGenerateAllTags = async () => {
    if (!serverUrl) return
    const gifs = gifsList.filter(g => g.type === 'gif')
    for (const gif of gifs) {
      setGeneratingTags(prev => new Set(prev).add(gif.id))
      try {
        const updated = await generateGifTags(serverUrl, gif.id)
        setGifsList(prev => prev.map(g => g.id === gif.id ? updated : g))
      } catch (err) {
        setGifMsg(handleApiErr(err))
        break
      } finally {
        setGeneratingTags(prev => {
          const next = new Set(prev)
          next.delete(gif.id)
          return next
        })
      }
    }
  }

  const handleDeleteStickerPack = async (packName: string) => {
    if (!confirm(`Delete sticker pack "${packName}" and all its stickers?`)) return
    if (!serverUrl) return
    try {
      await deleteStickerPack(serverUrl, packName)
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  // ─── Filter / sort members ──────────────────────────
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
    setInviteError(null)
    setRoleError(null)
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
              {section === 'members' && (
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
                                <code style={{ flex: 1, fontSize: '10px', color: 'var(--accent)', wordBreak: 'break-all', background: 'var(--bg-primary)', padding: '4px 6px', borderRadius: '4px' }}>{resetTokenData.token}</code>
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
              )}

              {/* Invites tab */}
              {section === 'invites' && (
                <div className="server-menu__section">
                  <div className="server-menu__invite-create">
                    <p className="server-menu__section-title" style={{ marginBottom: '8px' }}>create invite</p>
                    <div className="server-menu__invite-row">
                      <div className="server-menu__field">
                        <label className="server-menu__label">max uses (blank = infinite)</label>
                        <input type="number" min="1" className="server-menu__input" placeholder="unlimited" value={newMaxUses} onChange={(e) => setNewMaxUses(e.target.value)} />
                      </div>
                      <div className="server-menu__field">
                        <label className="server-menu__label">expires after</label>
                        <select className="server-menu__select" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)}>
                          {EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <button onClick={handleCreateInvite} disabled={creatingInvite} className="server-menu__role-create-btn">
                      {creatingInvite ? '...' : 'generate invite code'}
                    </button>
                    {inviteError && (
                      <span className="server-menu__save-msg server-menu__save-msg--err" style={{ marginTop: '6px', display: 'block' }}>{inviteError}</span>
                    )}
                  </div>

                  {activeQr && (
                    <div className="server-menu__qr-panel">
                      <p className="server-menu__section-title">invite code</p>
                      <img src={activeQr.dataUrl} alt="QR" className="server-menu__qr-img" />
                      <div className="server-menu__qr-code-row">
                        <code className="server-menu__qr-code">{activeQr.code}</code>
                        <button
                          onClick={() => navigator.clipboard.writeText(activeQr.code)}
                          className="server-menu__qr-copy-btn"
                        >
                          copy
                        </button>
                      </div>
                      <p className="server-menu__qr-hint">share this code — recipients join with just the code</p>
                      <button onClick={() => setActiveQr(null)} className="server-menu__qr-dismiss-btn">
                        dismiss
                      </button>
                    </div>
                  )}

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
                          <div>{inv.uses}/{inv.max_uses ?? '\u221E'} uses</div>
                          <div>{inv.expires_at ? new Date(inv.expires_at * 1000).toLocaleDateString() : 'never'}</div>
                        </div>
                        <div className="server-menu__invite-actions">
                          <button onClick={() => handleShowQr(inv)} className={`server-menu__invite-qr-btn ${activeQr?.code === inv.code ? 'server-menu__invite-qr-btn--active' : ''}`}>
                            qr
                          </button>
                          <button onClick={() => { if (activeQr?.code === inv.code) setActiveQr(null); handleRevokeInvite(inv.code) }} className="server-menu__invite-revoke">revoke</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Roles tab */}
              {section === 'roles' && (
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
              )}

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
              {section === 'gifs' && (
                <div className="server-menu__section">

                  <div className="server-menu__tab-bar" style={{ marginBottom: '12px' }}>
                    <Tabs
                      tabs={GIF_TABS}
                      activeKey={gifTab}
                      onChange={(key) => setGifTab(key as 'gif' | 'sticker')}
                      variant="pill"
                    />
                  </div>

                  {gifTab === 'gif' && (
                    <>
                      <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>upload single gif</p>
                      <div className="server-menu__gif-upload">
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                          <div className="server-menu__field" style={{ flex: 1 }}>
                            <label className="server-menu__label">name (optional)</label>
                            <input className="server-menu__input" value={gifName} onChange={(e) => setGifName(e.target.value)} placeholder="display name" />
                          </div>
                          <div className="server-menu__field" style={{ flex: 1 }}>
                            <label className="server-menu__label">category (optional)</label>
                            <input className="server-menu__input" value={gifCategory} onChange={(e) => setGifCategory(e.target.value)} placeholder="e.g. memes" />
                          </div>
                        </div>
                        <div className="server-menu__field" style={{ marginBottom: '8px' }}>
                          <label className="server-menu__label">tags — comma separated (optional)</label>
                          <input className="server-menu__input" value={gifTags} onChange={(e) => setGifTags(e.target.value)} placeholder="e.g. funny, cat" />
                        </div>
                        <button onClick={() => gifFileRef.current?.click()} disabled={gifUploading || !gifName.trim()} className="server-menu__upload-btn">
                          {gifUploading ? 'uploading...' : 'choose .gif file'}
                        </button>
                        {!gifName.trim() && <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block', marginTop: '4px' }}>name is required</span>}
                        <input ref={gifFileRef} type="file" accept=".gif" style={{ display: 'none' }} onChange={handleGifFile} />
                      </div>

                      <p className="server-menu__section-title" style={{ marginTop: '16px', marginBottom: '6px', fontSize: '11px' }}>upload gif pack (.zip)</p>
                      <div className="server-menu__gif-upload" style={{ marginBottom: '16px' }}>
                        <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
                          Upload a .zip of .gif files. Optionally include a pack.json manifest.
                        </p>
                        <button onClick={() => gifPackFileRef.current?.click()} disabled={gifUploading} className="server-menu__upload-btn">
                          {gifUploading ? 'uploading...' : 'choose .zip file'}
                        </button>
                        <input ref={gifPackFileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleGifPackFile} />
                      </div>

                      {gifMsg && (
                        <span className={`server-menu__save-msg ${gifMsg === 'uploaded' || gifMsg.startsWith('imported') ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`} style={{ marginBottom: '8px', display: 'block' }}>
                          {gifMsg}
                        </span>
                      )}

                      {taggerStatus.enabled && !taggerStatus.loaded && !taggerStatus.loading && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                          {showTaggerWarning ? (
                            <>
                              <span style={{ fontSize: '11px', color: '#e8b851', flex: 1 }}>
                                This will load a CLIP ViT-B/32 model using ~1.5 GB of RAM. Continue?
                              </span>
                              <button onClick={handleLoadTagger} disabled={taggerLoading} className="server-menu__upload-btn" style={{ fontSize: '11px', padding: '4px 8px' }}>
                                {taggerLoading ? 'loading...' : 'yes, load it'}
                              </button>
                              <button onClick={() => setShowTaggerWarning(false)} className="server-menu__upload-btn" style={{ fontSize: '11px', padding: '4px 8px' }}>
                                cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setShowTaggerWarning(true)}
                              disabled={taggerLoading}
                              className="server-menu__upload-btn"
                              style={{ fontSize: '11px', padding: '4px 8px' }}
                              title="Load the CLIP AI model for auto-tagging GIFs"
                            >
                              {taggerLoading ? 'loading...' : 'load tagging model'}
                            </button>
                          )}
                        </div>
                      )}
                      {taggerStatus.loading && (
                        <p style={{ fontSize: '11px', color: '#888', margin: '0 0 8px 0' }}>loading tagging model... this may take a minute</p>
                      )}
                      {taggerStatus.loaded && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                          <span style={{ fontSize: '11px', color: '#6f6' }}>model loaded</span>
                          <button onClick={handleUnloadTagger} disabled={generatingTags.size > 0} className="server-menu__upload-btn" style={{ fontSize: '11px', padding: '4px 8px' }}>
                            unload
                          </button>
                        </div>
                      )}

                      <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>gif library ({gifsList.filter(g => g.type === 'gif').length})</p>
                      {taggerStatus.loaded && (
                      <button
                        onClick={handleGenerateAllTags}
                        disabled={generatingTags.size > 0}
                        className="server-menu__upload-btn"
                        style={{ marginBottom: '8px', fontSize: '11px', padding: '4px 8px' }}
                        title="Generate AI tags for all GIFs that don't have suggested tags yet"
                      >
                        {generatingTags.size > 0 ? 'generating tags...' : '✨ generate tags for all'}
                      </button>
                      )}
                      {gifsLoading ? (
                        <p className="server-menu__loading">loading...</p>
                      ) : gifsList.filter(g => g.type === 'gif').length === 0 ? (
                        <p className="server-menu__loading">no gifs uploaded yet</p>
                      ) : (
                        <div className="server-menu__gif-grid">
                          {gifsList.filter(g => g.type === 'gif').map(gif => {
                            const resolvedUrl = gif.file_url.startsWith('/') ? `${serverUrl}${gif.file_url}` : gif.file_url
                            const isEditing = editingGifId === gif.id
                            return (
                              <div key={gif.id} className="server-menu__gif-item">
                                <img src={resolvedUrl} alt={gif.display_name} className="server-menu__gif-thumb" />
                                <div className="server-menu__gif-item-info">
                                  <span className="server-menu__gif-item-name">{gif.display_name}</span>
                                  <span className="server-menu__gif-item-cat">{gif.category}</span>
                                </div>
                                <button
                                  onClick={() => handleStartEdit(gif)}
                                  className="server-menu__gif-edit"
                                  title="Edit GIF"
                                >
                                  <Pencil size={12} />
                                </button>
                                {taggerStatus.loaded && (
                                <button
                                  onClick={() => handleGenerateTags(gif.id)}
                                  className="server-menu__gif-ai"
                                  title="Generate tags with AI"
                                  disabled={generatingTags.has(gif.id)}
                                >
                                  {generatingTags.has(gif.id) ? '...' : <span style={{ fontSize: '10px' }}>AI</span>}
                                </button>
                                )}
                                <button
                                  onClick={() => handleDeleteGif(gif.id)}
                                  className="server-menu__gif-delete"
                                  title="Delete GIF"
                                >
                                  <X size={12} />
                                </button>
                                {isEditing && (
                                  <div className="server-menu__gif-popover">
                                    <input value={gifEditName} onChange={e => setGifEditName(e.target.value)} placeholder="name" />
                                    <input value={gifEditCategory} onChange={e => setGifEditCategory(e.target.value)} placeholder="category" />
                                    <input value={gifEditTags} onChange={e => setGifEditTags(e.target.value)} placeholder="tags (comma separated)" />
                                    {gif.suggested_tags && (
                                      <div className="server-menu__gif-suggested">
                                        <div className="server-menu__gif-suggested-header">
                                          <span>suggested tags</span>
                                          <button
                                            onClick={() => handleDismissSuggestedTags(gif.id)}
                                            className="server-menu__gif-suggested-dismiss"
                                            title="Dismiss all suggestions"
                                          >
                                            dismiss all
                                          </button>
                                        </div>
                                        <div className="server-menu__gif-suggested-list">
                                          {gif.suggested_tags.split(',').map((t: string) => {
                                            const tag = t.trim()
                                            if (!tag) return null
                                            const currentTags = gifEditTags.split(',').map((ct: string) => ct.trim()).filter(Boolean)
                                            const alreadyAdded = currentTags.includes(tag)
                                            return (
                                              <button
                                                key={tag}
                                                onClick={() => handleAcceptSuggestedTag(gif, tag)}
                                                className={`server-menu__gif-suggested-tag ${alreadyAdded ? 'server-menu__gif-suggested-tag--accepted' : ''}`}
                                                disabled={alreadyAdded}
                                                title={alreadyAdded ? 'Already added' : 'Click to accept'}
                                              >
                                                {alreadyAdded ? '✓' : '+'} {tag}
                                              </button>
                                            )
                                          })}
                                        </div>
                                      </div>
                                    )}
                                    <div className="server-menu__gif-popover-actions">
                                      <button onClick={handleCancelEdit} className="server-menu__gif-popover-btn server-menu__gif-popover-btn--cancel">cancel</button>
                                      <button onClick={handleSaveEdit} disabled={!gifEditName.trim()} className="server-menu__gif-popover-btn server-menu__gif-popover-btn--save">save</button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}

                  {gifTab === 'sticker' && (
                    <>
                      <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>upload sticker pack (.zip)</p>
                      <div className="server-menu__gif-upload" style={{ marginBottom: '16px' }}>
                        <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
                          Upload a .zip containing .gif, .png, or .webp stickers. Optionally include a pack.json manifest.
                        </p>
                        <button onClick={() => stickerPackFileRef.current?.click()} disabled={gifUploading} className="server-menu__upload-btn">
                          {gifUploading ? 'uploading...' : 'choose .zip file'}
                        </button>
                        <input ref={stickerPackFileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleStickerPackFile} />
                      </div>

                      <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>add a single sticker</p>
                      <div className="server-menu__gif-upload" style={{ marginBottom: '16px' }}>
                        <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
                          Upload one .gif, .png, or .webp sticker into an existing pack or a brand-new one.
                        </p>
                        <button onClick={() => openStickerUpload()} disabled={gifUploading} className="server-menu__upload-btn">
                          add sticker
                        </button>
                      </div>

                      {gifMsg && (
                        <span className={`server-menu__save-msg ${gifMsg === 'uploaded' || gifMsg.startsWith('imported') ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`} style={{ marginBottom: '8px', display: 'block' }}>
                          {gifMsg}
                        </span>
                      )}

                      <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>sticker packs</p>
                      {gifsLoading ? (
                        <p className="server-menu__loading">loading...</p>
                      ) : (() => {
                        const stickerPacks = [...new Set(gifsList.filter(g => g.type === 'sticker' && g.pack_name).map(g => g.pack_name!))]
                        return stickerPacks.length === 0 ? (
                          <p className="server-menu__loading">no sticker packs uploaded yet</p>
                        ) : stickerPacks.map(pack => {
                          const packCount = gifsList.filter(g => g.type === 'sticker' && g.pack_name === pack).length
                          return (
                            <div key={pack} className="server-menu__gif-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', marginBottom: '4px' }}>
                              <div>
                                <span style={{ fontWeight: 600, fontSize: '13px' }}>{pack}</span>
                                <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '8px' }}>{packCount} sticker{packCount !== 1 ? 's' : ''}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <button
                                  onClick={() => openStickerUpload(pack)}
                                  className="server-menu__upload-btn"
                                  style={{ padding: '4px 10px', fontSize: '11px' }}
                                  title={`Add a sticker to ${pack}`}
                                >
                                  + add
                                </button>
                                <button
                                  onClick={() => handleDeleteStickerPack(pack)}
                                  className="server-menu__gif-delete"
                                  style={{ position: 'static' }}
                                  title="Delete pack"
                                >
                                  delete pack
                                </button>
                              </div>
                            </div>
                          )
                        })
                      })()}
                    </>
                  )}
                </div>
              )}

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

    {/* Styled popup for naming a sticker pack during .zip import (replaces window.prompt) */}
    <Modal
      open={packNameModal.open}
      onClose={() => setPackNameModal({ open: false, file: null, name: '' })}
      title="// name sticker pack"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            className="server-menu__confirm-cancel"
            onClick={() => setPackNameModal({ open: false, file: null, name: '' })}
            disabled={gifUploading}
          >
            cancel
          </button>
          <button
            className="server-menu__upload-btn"
            onClick={confirmStickerPackUpload}
            disabled={gifUploading || !packNameModal.name.trim()}
          >
            {gifUploading ? 'importing...' : 'import pack'}
          </button>
        </div>
      }
    >
      <label className="server-menu__label">pack name</label>
      <input
        autoFocus
        className="server-menu__input"
        placeholder="e.g. Summer Stickers"
        value={packNameModal.name}
        maxLength={100}
        onChange={(e) => setPackNameModal((s) => ({ ...s, name: e.target.value }))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && packNameModal.name.trim()) confirmStickerPackUpload()
        }}
      />
    </Modal>

    {/* Styled popup for uploading a single sticker into an existing or new pack */}
    {(() => {
      const existingPacks = [...new Set(gifsList.filter((g) => g.type === 'sticker' && g.pack_name).map((g) => g.pack_name!))]
      const resolvedPack = (stickerUpload.selectedPack || stickerUpload.newPackName).trim()
      const canSubmit = !!stickerUpload.file && !!resolvedPack && !stickerUpload.uploading
      return (
        <Modal
          open={stickerUpload.open}
          onClose={() => setStickerUpload((s) => ({ ...s, open: false }))}
          title="// add sticker"
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="server-menu__confirm-cancel"
                onClick={() => setStickerUpload((s) => ({ ...s, open: false }))}
                disabled={stickerUpload.uploading}
              >
                cancel
              </button>
              <button className="server-menu__upload-btn" onClick={confirmStickerUpload} disabled={!canSubmit}>
                {stickerUpload.uploading ? 'uploading...' : 'add sticker'}
              </button>
            </div>
          }
        >
          <label className="server-menu__label">sticker file</label>
          <div style={{ marginBottom: '12px' }}>
            <button className="server-menu__upload-btn" onClick={() => singleStickerFileRef.current?.click()}>
              {stickerUpload.file ? stickerUpload.file.name : 'choose .gif / .png / .webp'}
            </button>
            <input
              ref={singleStickerFileRef}
              type="file"
              accept=".gif,.png,.webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null
                setStickerUpload((s) => ({ ...s, file }))
                e.target.value = ''
              }}
            />
          </div>

          <label className="server-menu__label">pack</label>
          <select
            className="server-menu__select"
            value={stickerUpload.selectedPack}
            onChange={(e) => setStickerUpload((s) => ({ ...s, selectedPack: e.target.value }))}
            style={{ marginBottom: '8px' }}
          >
            <option value="">+ new pack…</option>
            {existingPacks.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {!stickerUpload.selectedPack && (
            <input
              className="server-menu__input"
              placeholder="new pack name"
              value={stickerUpload.newPackName}
              maxLength={100}
              onChange={(e) => setStickerUpload((s) => ({ ...s, newPackName: e.target.value }))}
              style={{ marginBottom: '12px' }}
            />
          )}

          <label className="server-menu__label">display name (optional)</label>
          <input
            className="server-menu__input"
            placeholder="defaults to file name"
            value={stickerUpload.displayName}
            maxLength={100}
            onChange={(e) => setStickerUpload((s) => ({ ...s, displayName: e.target.value }))}
          />
        </Modal>
      )
    })()}

    </>
  )
}
