import { useEffect, useState, useRef, useCallback } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
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
  fetchGifs,
  deleteGif,
  deleteStickerPack,
} from '@kizuna/shared'
import type { Member, CustomRole, Permission, UserStatus, GifInfo } from '@kizuna/shared'
import '../styles/server-menu.css'

interface Props {
  onClose: () => void
}

function handleApiErr(err: unknown): string {
  const e = err as any
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

type AdminTab = 'settings' | 'members' | 'invites' | 'roles' | 'css' | 'gifs'

const ALL_PERMISSIONS: { key: Permission; label: string; desc: string }[] = [
  { key: 'send_messages', label: 'send', desc: 'Post messages in guild text channels' },
  { key: 'send_dm_messages', label: 'dm', desc: 'Send direct messages to other users' },
  { key: 'add_reactions', label: 'react', desc: 'Add emoji and sticker reactions to messages' },
  { key: 'upload_attachments', label: 'attach', desc: 'Upload files, images, and attachments' },
  { key: 'delete_messages', label: 'delete', desc: 'Remove messages from any user' },
  { key: 'manage_channels', label: 'channels', desc: 'Create, edit, and delete channels' },
  { key: 'manage_roles', label: 'roles', desc: 'Create, edit, delete, and assign roles' },
  { key: 'kick_members', label: 'kick', desc: 'Remove members from the server' },
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
  const settings = useChatStore((s) => s.notificationSettings)
  const setNotificationSettings = useChatStore((s) => s.setNotificationSettings)
  const serverId = session?.serverId || ''
  const current = settings[serverId] || { level: 'all' as const, suppressEveryone: false }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
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
        <label className="server-menu__toggle-switch">
          <input
            type="checkbox"
            checked={current.suppressEveryone}
            onChange={(e) => setNotificationSettings(serverId, { ...current, suppressEveryone: e.target.checked })}
          />
          <span className="server-menu__toggle-track">
            <span className="server-menu__toggle-thumb" />
          </span>
        </label>
      </div>
    </div>
  )
}

export default function ServerMenuModal({ onClose }: Props) {
  const { activeSession: session, updateServerInfo, servers } = useServerStore()
  const { members, setMembers, userStatuses } = useChatStore()
  const serverUrl = session?.url
  const isAdmin = session?.user?.role === 'admin'
  const [closing, setClosing] = useState(false)
  const mountedRef = useRef(false)
  mountedRef.current = true
  useEffect(() => {
    return () => { mountedRef.current = false }
  }, [])

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => { if (mountedRef.current) onClose() }, 200)
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
  const [bannerPreview, setBannerPreview] = useState<string | null>(session?.user?.banner ?? null)
  const [bannerChanged, setBannerChanged] = useState(false)
  const bannerFileRef = useRef<HTMLInputElement>(null)
  const pendingBannerFile = useRef<File | null>(null)

  // ─── Admin tab ───────────────────────────────────────
  const [adminTab, setAdminTab] = useState<AdminTab>('settings')

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

  const existingIcon = session ? servers.find(s => s.id === session.serverId)?.icon ?? null : null
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
    }).catch(() => {
      if (mountedRef.current) {
        clearTimeout(delay)
        setInfoLoading(false)
      }
    })

    return () => clearTimeout(delay)
  }, [serverUrl])

  useEffect(() => {
    const previewEl = document.getElementById('kizuna-custom-css-preview') as HTMLStyleElement | null
    if (adminTab === 'css' && customCss) {
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
  }, [adminTab, customCss])

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
      } catch {}
    }, 300)
  }, [])

  // auto-save background blur on change
  const blurInitRef = useRef(true)
  useEffect(() => {
    if (blurInitRef.current) { blurInitRef.current = false; return }
    if (!serverUrl) return
    const timer = setTimeout(async () => {
      try {
        await updateServerSettings(serverUrl, undefined, undefined, bgBlur)
      } catch {}
    }, 400)
    return () => clearTimeout(timer)
  }, [bgBlur, serverUrl])

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
  const [invites, setInvites] = useState<any[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [newMaxUses, setNewMaxUses] = useState('')
  const [newExpiry, setNewExpiry] = useState('0')
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [activeQr, setActiveQr] = useState<{ code: string; dataUrl: string } | null>(null)

  // ─── Roles ───────────────────────────────────────────
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleColor, setNewRoleColor] = useState('#5865f2')
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

  // ─── GIFs & Stickers ────────────────────────────────
  const [gifsList, setGifsList] = useState<GifInfo[]>([])
  const [gifsLoading, setGifsLoading] = useState(false)
  const [gifUploading, setGifUploading] = useState(false)
  const [gifMsg, setGifMsg] = useState<string | null>(null)
  const [gifTab, setGifTab] = useState<'gif' | 'sticker'>('gif')
  const [gifName, setGifName] = useState('')
  const [gifCategory, setGifCategory] = useState('')
  const [gifTags, setGifTags] = useState('')
  const gifFileRef = useRef<HTMLInputElement>(null)
  const gifPackFileRef = useRef<HTMLInputElement>(null)
  const stickerPackFileRef = useRef<HTMLInputElement>(null)

  function memberRoleCount(roleId: string): number {
    return members.filter(m => (m.custom_roles || []).some(r => r.id === roleId)).length
  }

  useEffect(() => {
    if (!isAdmin || !serverUrl) return
    if (adminTab === 'members') {
      setMembersLoading(true)
      fetchMembers(serverUrl).then(d => { if (mountedRef.current) setMembers(d) }).catch(console.error).finally(() => { if (mountedRef.current) setMembersLoading(false) })
      loadRoles()
    } else if (adminTab === 'invites') {
      loadInvites()
    } else if (adminTab === 'roles') {
      loadRoles()
    } else if (adminTab === 'gifs') {
      loadGifs()
    }
  }, [adminTab, isAdmin, serverUrl])

  async function loadInvites() {
    if (!serverUrl) return
    setInvitesLoading(true)
    try { if (mountedRef.current) setInvites(await fetchInvites(serverUrl)) } catch {}
    if (mountedRef.current) setInvitesLoading(false)
  }

  async function loadRoles() {
    if (!serverUrl) return
    setRolesLoading(true)
    try { if (mountedRef.current) setRoles(await fetchRoles(serverUrl)) } catch {}
    if (mountedRef.current) setRolesLoading(false)
  }

  async function loadGifs() {
    if (!serverUrl) return
    setGifsLoading(true)
    try {
      const gifs = await fetchGifs(serverUrl, { limit: 200 })
      if (mountedRef.current) setGifsList(gifs)
    } catch {}
    if (mountedRef.current) setGifsLoading(false)
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
    } catch {}
    setAssigningRole(prev => ({ ...prev, [userId + roleId]: false }))
  }

  const handleRemoveRole = async (userId: string, roleId: string) => {
    if (!serverUrl) return
    setAssigningRole(prev => ({ ...prev, [userId + roleId]: true }))
    try {
      await removeMemberRole(serverUrl, userId, roleId)
    } catch {}
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
      } catch {}
    }
    clearSelection()
  }

  const handleBulkKick = async () => {
    if (!serverUrl) return
    const targets = members.filter(m => selectedMembers.has(m.id) && m.id !== session?.user?.id)
    for (const m of targets) {
      try {
        await kickMember(serverUrl, m.id)
      } catch {}
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
      } catch {}
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
    } catch {}
    setCreatingInvite(false)
  }

  const handleShowQr = async (invite: any) => {
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
    } catch {}
  }

  // ─── Role handlers ──────────────────────────────────
  const handleCreateRole = async () => {
    if (!newRoleName.trim() || !serverUrl) return
    setCreatingRole(true)
    try {
      const role = await createRole(serverUrl, newRoleName.trim(), newRoleColor, newRolePerms, newRoleHoist, newRoleMentionable, newRoleDefaultOnJoin)
      setRoles(prev => [...prev, role])
      setNewRoleName('')
      setNewRoleColor('#5865f2')
      setNewRolePerms({})
      setNewRoleHoist(false)
      setNewRoleMentionable(false)
      setNewRoleDefaultOnJoin(false)
      setShowCreateRole(false)
    } catch {}
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
    } catch {}
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
    } catch {}
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

  const handleStickerPackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    const packName = prompt('Enter a name for this sticker pack:')
    if (!packName?.trim()) return
    setGifUploading(true)
    setGifMsg(null)
    try {
      const result = await uploadStickerPack(serverUrl, file, packName.trim())
      setGifMsg(`imported ${result.imported} stickers`)
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
    e.target.value = ''
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

            <div className="server-menu__field" style={{ marginTop: '16px' }}>
              <label className="server-menu__label">display name</label>
              <input className="server-menu__input" maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="display name" />
            </div>
            <div className="server-menu__toggle-row">
              <label className="server-menu__label" style={{ margin: 0 }}>show server background</label>
              <label className="server-menu__toggle-switch">
                <input
                  type="checkbox"
                  checked={useChatStore(s => s.serverBackgroundEnabled)}
                  onChange={(e) => useChatStore.getState().setServerBackgroundEnabled(e.target.checked)}
                />
                <span className="server-menu__toggle-track">
                  <span className="server-menu__toggle-thumb" />
                </span>
              </label>
            </div>
            <div className="server-menu__toggle-row">
              <label className="server-menu__label" style={{ margin: 0 }}>enable custom css</label>
              <label className="server-menu__toggle-switch">
                <input
                  type="checkbox"
                  checked={useChatStore(s => s.customCssEnabled)}
                  onChange={(e) => useChatStore.getState().setCustomCssEnabled(e.target.checked)}
                />
                <span className="server-menu__toggle-track">
                  <span className="server-menu__toggle-thumb" />
                </span>
              </label>
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

          {/* Notifications */}
          <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
            <p className="server-menu__section-title">notifications</p>
            <NotificationSettings />
          </section>

          {/* Admin */}
          {isAdmin && (
            <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
              <p className="server-menu__section-title">admin</p>

              <div className="server-menu__tab-bar">
                {(['settings', 'members', 'invites', 'roles', 'css', 'gifs'] as AdminTab[]).map(t => (
                  <button key={t} onClick={() => setAdminTab(t)}
                    className={`server-menu__tab ${adminTab === t ? 'server-menu__tab--active' : ''}`}>
                    {t}
                  </button>
                ))}
              </div>

              {/* Settings tab */}
              {adminTab === 'settings' && (
                <div style={{ marginTop: '16px' }}>
                  {infoLoading && <p className="server-menu__info-loading">loading server info...</p>}
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
                  <div className="server-menu__field" style={{ marginTop: '12px' }}>
                    <label className="server-menu__label">server name</label>
                    <input className="server-menu__input" maxLength={100} value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="server name" />
                  </div>
                  <div className="server-menu__field" style={{ marginTop: '16px' }}>
                    <label className="server-menu__label">background image</label>
                    <div className="server-menu__bg-row">
                      {bgPreviewUrl && (
                        <div className="server-menu__bg-preview" style={{ backgroundImage: `url(${bgPreviewUrl})` }} />
                      )}
                      <div className="server-menu__bg-actions">
                        <button onClick={() => bgFileRef.current?.click()} disabled={bgUploading} className="server-menu__upload-btn">
                          {bgUploading ? 'uploading...' : 'upload background'}
                        </button>
                        {bgHasImage && (
                          <button onClick={handleRemoveBg} className="server-menu__remove-btn">remove background</button>
                        )}
                      </div>
                      <input ref={bgFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgFile} />
                    </div>
                  </div>
                  <div className="server-menu__field" style={{ marginTop: '12px' }}>
                    <label className="server-menu__label">background blur ({bgBlur}px)</label>
                    <input type="range" min="0" max="20" value={bgBlur} onChange={(e) => setBgBlur(Number(e.target.value))} className="server-menu__range" />
                  </div>
                  <div className="server-menu__field" style={{ marginTop: '12px' }}>
                    <label className="server-menu__label">voice bitrate</label>
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
                  <div className="server-menu__save-row">
                    <button onClick={handleSaveServer} disabled={serverSaving} className="server-menu__save-btn">
                      {serverSaving ? '...' : 'save settings'}
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
              {adminTab === 'members' && (
                <div style={{ marginTop: '16px' }}>
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
                                {m.is_host && <span className="server-menu__member-badge" style={{ color: '#f59e0b', borderColor: '#f59e0b66', backgroundColor: '#f59e0b22', marginLeft: '4px' }}>host</span>}
                              </p>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                {(m.custom_roles || []).map((r) => (
                                  <span key={r.id} className="server-menu__member-badge"
                                    style={{ color: r.color || '#5865f2', borderColor: (r.color || '#5865f2') + '66', backgroundColor: (r.color || '#5865f2') + '22' }}>
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
                              <span className="server-menu__member-badge" style={{ color: '#fbbf24', borderColor: '#fbbf2466', backgroundColor: '#fbbf2422' }}>
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
                        <select className="server-menu__select" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)}>
                          {EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                    </div>
                    <button onClick={handleCreateInvite} disabled={creatingInvite} className="server-menu__role-create-btn">
                      {creatingInvite ? '...' : 'generate invite code'}
                    </button>
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
              {adminTab === 'roles' && (
                <div style={{ marginTop: '16px' }}>
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
                                          const currentIdx = newRoles.findIndex(r => r.id === role.id)
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
                                            } catch {}
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
                                            } catch {}
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
                                    className={`server-menu__perm-toggle ${(role.permissions as any)?.[p.key] ? 'server-menu__perm-toggle--on' : ''}`}
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
                </div>
              )}

              {/* Custom CSS tab */}
              {adminTab === 'css' && (
                <div style={{ marginTop: '16px' }}>
                  <p className="server-menu__section-title" style={{ marginBottom: '4px' }}>custom css</p>
                  <p className="server-menu__css-hint">
                    Override CSS variables to theme your server. Changes preview live below.
                  </p>
                  <textarea
                    className="server-menu__css-editor"
                    value={customCss}
                    onChange={(e) => setCustomCss(e.target.value.slice(0, 50000))}
                    maxLength={50000}
                    placeholder={`/* Kizuna Custom CSS — override any variable below */\n:root {\n  /* Backgrounds */\n  --bg-primary: #0a0a0a;\n  --bg-secondary: #111111;\n  --bg-tertiary: #1a1a1a;\n  --bg-hover: #262626;\n  --bg-active: #2d2d2d;\n\n  /* Text */\n  --text-primary: #ffffff;\n  --text-secondary: #a0a0a0;\n  --text-muted: #6b6b6b;\n\n  /* Borders */\n  --border-color: #2a2a2a;\n\n  /* Brand / Accent */\n  --brand: #4c6ef5;\n  --brand-hover: #4263eb;\n  --brand-dim: rgba(76, 110, 245, 0.15);\n  --accent-color: #6366f1;\n\n  /* Semantic colors */\n  --red: #ff4d4d;\n  --red-hover: #ff3333;\n  --red-dim: rgba(255, 77, 77, 0.15);\n  --red-dim-border: rgba(255, 77, 77, 0.30);\n  --green: #40c057;\n  --green-dim: rgba(64, 192, 87, 0.15);\n  --green-dim-border: rgba(64, 192, 87, 0.20);\n  --yellow: #fab005;\n\n  /* Border radius */\n  --radius-sm: 8px;\n  --radius-md: 12px;\n  --radius-lg: 16px;\n  --radius-xl: 24px;\n  --radius-full: 9999px;\n\n  /* Font */\n  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;\n}`}
                    spellCheck={false}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                    <span className={`server-menu__css-char-count${customCss.length > 45000 ? ' server-menu__css-char-count--warn' : ''}${customCss.length >= 50000 ? ' server-menu__css-char-count--over' : ''}`}>
                      {customCss.length} / 50000
                    </span>
                  </div>
                  <div className="server-menu__save-row">
                    <button onClick={handleSaveCustomCss} disabled={customCssSaving || customCss.length > 50000} className="server-menu__save-btn">
                      {customCssSaving ? '...' : 'save css'}
                    </button>
                    {customCssMsg && (
                      <span className={`server-menu__save-msg ${customCssMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
                        {customCssMsg}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* GIFs & Stickers tab */}
              {adminTab === 'gifs' && (
                <div style={{ marginTop: '16px' }}>
                  <p className="server-menu__section-title" style={{ marginBottom: '8px' }}>gifs & stickers</p>

                  <div className="server-menu__tab-bar" style={{ marginBottom: '12px' }}>
                    <button
                      onClick={() => setGifTab('gif')}
                      className={`server-menu__tab ${gifTab === 'gif' ? 'server-menu__tab--active' : ''}`}
                    >
                      gif
                    </button>
                    <button
                      onClick={() => setGifTab('sticker')}
                      className={`server-menu__tab ${gifTab === 'sticker' ? 'server-menu__tab--active' : ''}`}
                    >
                      sticker
                    </button>
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
                        <button onClick={() => gifFileRef.current?.click()} disabled={gifUploading} className="server-menu__upload-btn">
                          {gifUploading ? 'uploading...' : 'choose .gif file'}
                        </button>
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

                      <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>gif library ({gifsList.filter(g => g.type === 'gif').length})</p>
                      {gifsLoading ? (
                        <p className="server-menu__loading">loading...</p>
                      ) : gifsList.filter(g => g.type === 'gif').length === 0 ? (
                        <p className="server-menu__loading">no gifs uploaded yet</p>
                      ) : (
                        <div className="server-menu__gif-grid">
                          {gifsList.filter(g => g.type === 'gif').map(gif => {
                            const resolvedUrl = gif.file_url.startsWith('/') ? `${serverUrl}${gif.file_url}` : gif.file_url
                            return (
                              <div key={gif.id} className="server-menu__gif-item">
                                <img src={resolvedUrl} alt={gif.display_name} className="server-menu__gif-thumb" />
                                <div className="server-menu__gif-item-info">
                                  <span className="server-menu__gif-item-name">{gif.display_name}</span>
                                  <span className="server-menu__gif-item-cat">{gif.category}</span>
                                </div>
                                <button
                                  onClick={() => handleDeleteGif(gif.id)}
                                  className="server-menu__gif-delete"
                                  title="Delete GIF"
                                >
                                  x
                                </button>
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
                              <button
                                onClick={() => handleDeleteStickerPack(pack)}
                                className="server-menu__gif-delete"
                                style={{ position: 'static' }}
                                title="Delete pack"
                              >
                                delete pack
                              </button>
                            </div>
                          )
                        })
                      })()}
                    </>
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
