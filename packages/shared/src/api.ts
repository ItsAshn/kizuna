import axios from 'axios'
import type {
  User,
  Channel,
  Message,
  Member,
  InviteCode,
  CustomRole,
  Permission,
  DMChannelData,
  GroupDMChannelData,
  FileAttachment,
  ServerInfo,
  PoWChallenge,
  AdminInfo,
  ChannelMute,
  GifInfo,
  LinkEmbed,
  TaggerStatus,
  Thread,
  PublicServerEntry,
  LinkedIdentity,
} from './types'

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '')
}

const tokenStore = new Map<string, string>()

export function setClientToken(serverUrl: string, token: string): void {
  tokenStore.set(normalizeUrl(serverUrl), token)
}

export function clearClientToken(serverUrl: string): void {
  tokenStore.delete(normalizeUrl(serverUrl))
}

type TokenRefreshHandler = (serverUrl: string) => Promise<string | null>

let tokenRefreshHandler: TokenRefreshHandler | null = null

export function setTokenRefreshHandler(handler: TokenRefreshHandler): void {
  tokenRefreshHandler = handler
}

const refreshMap = new Map<string, Promise<string | null>>()

function client(baseUrl: string, token?: string) {
  const norm = normalizeUrl(baseUrl)
  const effectiveToken = token || tokenStore.get(norm)
  const headers: Record<string, string> = {}
  if (effectiveToken) headers.Authorization = `Bearer ${effectiveToken}`

  const instance = axios.create({
    baseURL: norm,
    headers,
    withCredentials: true,
  })

  instance.interceptors.response.use(
    (res) => res,
    async (error) => {
      if (error.response?.status !== 401) throw error
      if (error.config?._retry) throw error
      if (!tokenRefreshHandler) throw error

      const reqUrl: string = error.config?.url || ''
      if (reqUrl.includes('/auth/refresh')) throw error

      error.config._retry = true

      let refreshP = refreshMap.get(norm)
      if (!refreshP) {
        refreshP = tokenRefreshHandler(norm).finally(() => {
          refreshMap.delete(norm)
        })
        refreshMap.set(norm, refreshP)
      }

      const newToken = await refreshP
      if (!newToken) throw error

      tokenStore.set(norm, newToken)
      error.config.headers.Authorization = `Bearer ${newToken}`
      return instance(error.config)
    },
  )

  return instance
}

// ─── Auth ─────────────────────────────────────────────────

export async function getChallenge(
  serverUrl: string,
): Promise<PoWChallenge> {
  const res = await axios.get(`${normalizeUrl(serverUrl)}/api/auth/challenge`)
  return res.data
}

export async function register(
  serverUrl: string,
  username: string,
  password: string,
  display_name?: string,
  serverPassword?: string,
  public_key?: string,
  key_salt?: string,
  challenge?: string,
  nonce?: string,
): Promise<{ token: string; user: User; backuptoken: string }> {
  const res = await axios.post(`${normalizeUrl(serverUrl)}/api/auth/register`, {
    username,
    password,
    display_name: display_name || username,
    ...(serverPassword ? { serverPassword } : {}),
    ...(public_key ? { public_key } : {}),
    ...(key_salt ? { key_salt } : {}),
    ...(challenge ? { challenge } : {}),
    ...(nonce ? { nonce } : {}),
  })
  return res.data
}

export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; user: User }> {
  const res = await axios.post(`${normalizeUrl(serverUrl)}/api/auth/login`, {
    username,
    password,
  })
  return res.data
}

export async function refreshToken(
  serverUrl: string,
): Promise<string | null> {
  try {
    const res = await client(serverUrl).post('/api/auth/refresh')
    return res.data.token ?? null
  } catch {
    return null
  }
}

export async function getMe(serverUrl: string): Promise<User> {
  const res = await client(serverUrl).get('/api/auth/me')
  return res.data.user
}

export async function updateStatus(
  serverUrl: string,
  status_text?: string | null,
  status_emoji?: string | null,
  status_sticker_id?: string | null,
): Promise<void> {
  await client(serverUrl).patch('/api/auth/me/status', { status_text, status_emoji, status_sticker_id })
}

export async function uploadPublicKey(
  serverUrl: string,
  publicKey: string,
  keySalt?: Uint8Array,
): Promise<void> {
  await client(serverUrl).put('/api/auth/public-key', {
    public_key: publicKey,
    key_salt: keySalt != null ? JSON.stringify(Array.from(keySalt)) : undefined,
  })
}

export async function getUserPublicKey(
  serverUrl: string,
  userId: string,
): Promise<string | null> {
  const res = await client(serverUrl).get(`/api/auth/users/${userId}/public-key`)
  return res.data.public_key ?? null
}

export async function validateResetToken(
  serverUrl: string,
  resetToken: string,
): Promise<{ username: string }> {
  const res = await axios.get(`${normalizeUrl(serverUrl)}/api/auth/reset-password/${resetToken}`)
  return res.data
}

export async function resetPassword(
  serverUrl: string,
  resetToken: string,
  password: string,
): Promise<{ backuptoken: string }> {
  const res = await axios.post(`${normalizeUrl(serverUrl)}/api/auth/reset-password/${resetToken}`, { password })
  return res.data
}

export async function resetWithBackupToken(
  serverUrl: string,
  username: string,
  backuptoken: string,
  newPassword: string,
): Promise<{ backuptoken: string }> {
  const res = await axios.post(`${normalizeUrl(serverUrl)}/api/auth/reset-with-backuptoken`, {
    username,
    backuptoken,
    new_password: newPassword,
  })
  return res.data
}

export async function generatePasswordReset(
  serverUrl: string,
  userId: string,
): Promise<{ resetToken: string; username: string; expiresAt: number }> {
  const res = await client(serverUrl).post(`/api/server/members/${userId}/generate-reset`)
  return res.data
}

export async function requestPasswordReset(
  serverUrl: string,
  username: string,
): Promise<void> {
  await axios.post(`${normalizeUrl(serverUrl)}/api/auth/request-reset`, { username })
}

export async function getAdminList(
  serverUrl: string,
): Promise<AdminInfo[]> {
  const res = await axios.get(`${normalizeUrl(serverUrl)}/api/server/admins`)
  return res.data.admins ?? res.data
}

export async function fetchServerInfo(serverUrl: string): Promise<ServerInfo> {
  const res = await axios.get(`${normalizeUrl(serverUrl)}/api/server/info`, {
    timeout: 8000,
    params: { _t: Date.now() },
  })
  return res.data as ServerInfo
}

export async function fetchPublicServers(registryUrl: string): Promise<PublicServerEntry[]> {
  const res = await axios.get(`${normalizeUrl(registryUrl)}/api/registry/servers`, {
    timeout: 8000,
  })
  return res.data as PublicServerEntry[]
}

export async function resolveInviteCode(
  code: string,
): Promise<{ serverUrl: string; name: string; description: string }> {
  const parts = code.toUpperCase().split('.')
  if (parts.length !== 2) throw new Error('Invalid invite code format')
  const encodedUrl = parts[0]!;
  let serverUrl: string
  try {
    serverUrl = atob(encodedUrl.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    throw new Error('Invalid invite code format')
  }
  const res = await axios.get(
    `${normalizeUrl(serverUrl)}/api/server/resolve/${code.toUpperCase()}`,
    { timeout: 8000 },
  )
  return res.data
}

// ─── Channels ─────────────────────────────────────────────

export async function fetchChannels(
  serverUrl: string,
): Promise<Channel[]> {
  const res = await client(serverUrl).get('/api/channels')
  return res.data.channels ?? res.data
}

export async function createChannel(
  serverUrl: string,
  name: string,
  type: 'text' | 'voice',
  locked = false,
  hidden = false,
  hidden_role_ids?: string[] | null,
): Promise<Channel> {
  const res = await client(serverUrl).post('/api/channels', { name, type, locked, hidden, hidden_role_ids })
  return res.data.channel ?? res.data
}

export async function deleteChannel(
  serverUrl: string,
  id: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/channels/${id}`)
}

export async function reorderChannels(
  serverUrl: string,
  order: { id: string; position: number }[],
): Promise<void> {
  await client(serverUrl).patch('/api/channels/reorder', { order })
}

export async function lockChannel(
  serverUrl: string,
  id: string,
  locked: boolean,
): Promise<Channel> {
  const res = await client(serverUrl).patch(`/api/channels/${id}`, { locked })
  return res.data.channel ?? res.data
}

export async function hideChannel(
  serverUrl: string,
  id: string,
  hidden: boolean,
  hidden_role_ids?: string[] | null,
): Promise<Channel> {
  const res = await client(serverUrl).patch(`/api/channels/${id}`, { hidden, hidden_role_ids })
  return res.data.channel ?? res.data
}

export async function fetchChannelPermissions(
  serverUrl: string,
  channelId: string,
): Promise<{ can_write: boolean; locked: boolean; can_view: boolean; hidden: boolean; permissions?: Record<string, boolean> }> {
  const res = await client(serverUrl).get(`/api/channels/${channelId}/permissions`)
  return res.data
}

export async function fetchChannelOverrides(
  serverUrl: string,
  channelId: string,
): Promise<{ channel_id: string; role_id: string; role_name: string; role_color: string; role_position: number; allow_permissions: Record<string, boolean>; deny_permissions: Record<string, boolean> }[]> {
  const res = await client(serverUrl).get(`/api/channels/${channelId}/overrides`)
  return res.data.overrides ?? []
}

export async function setChannelOverride(
  serverUrl: string,
  channelId: string,
  roleId: string,
  allowPermissions: Record<string, boolean>,
  denyPermissions: Record<string, boolean>,
): Promise<void> {
  await client(serverUrl).put(`/api/channels/${channelId}/overrides/${roleId}`, {
    allow_permissions: allowPermissions,
    deny_permissions: denyPermissions,
  })
}

export async function deleteChannelOverride(
  serverUrl: string,
  channelId: string,
  roleId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/channels/${channelId}/overrides/${roleId}`)
}

// ─── Messages ─────────────────────────────────────────────

export async function fetchMessages(
  serverUrl: string,
  channelId: string,
  limit = 50,
  before?: string,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const params: Record<string, string | number> = { limit }
  if (before) params.before = before
  const res = await client(serverUrl).get(`/api/messages/${channelId}`, { params })
  return { messages: res.data.messages ?? res.data, hasMore: res.data.hasMore ?? false }
}

export async function sendMessage(
  serverUrl: string,
  channelId: string,
  content: string,
  attachmentIds?: string[],
  replyToMessageId?: string,
): Promise<Message> {
  const body: Record<string, unknown> = { content }
  if (attachmentIds?.length) body.attachment_ids = attachmentIds
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId
  const res = await client(serverUrl).post(`/api/messages/${channelId}`, body)
  return res.data.message ?? res.data
}

export async function deleteMessage(
  serverUrl: string,
  messageId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/messages/${messageId}`)
}

export async function editMessage(
  serverUrl: string,
  messageId: string,
  content: string,
): Promise<Message> {
  const res = await client(serverUrl).patch(`/api/messages/${messageId}`, { content })
  return res.data.message ?? res.data
}

// ─── Members ──────────────────────────────────────────────

export async function fetchMembers(
  serverUrl: string,
): Promise<Member[]> {
  const res = await client(serverUrl).get('/api/auth/users')
  return res.data.users ?? res.data
}

export async function getUserProfile(
  serverUrl: string,
  userId: string,
): Promise<Member> {
  const res = await client(serverUrl).get(`/api/auth/users/${userId}`)
  return res.data
}

// ─── Profile ──────────────────────────────────────────────

export async function updateProfile(
  serverUrl: string,
  display_name?: string,
  avatar?: string | null,
  banner?: string | null,
): Promise<User> {
  const res = await client(serverUrl).patch('/api/auth/profile', {
    display_name,
    avatar,
    banner,
  })
  return res.data.user ?? res.data
}

// ─── Server Settings ──────────────────────────────────────

export async function updateServerSettings(
  serverUrl: string,
  name?: string,
  icon?: string | null,
  background_blur?: number,
  customCss?: string | null,
  voiceBitrateKbps?: number,
  profanityFilterEnabled?: boolean,
  blockedWords?: string[],
): Promise<ServerInfo> {
  const body: Record<string, unknown> = {}
  if (name !== undefined) body.name = name
  if (icon !== undefined) body.icon = icon
  if (background_blur !== undefined) body.background_blur = background_blur
  if (customCss !== undefined) body.custom_css = customCss
  if (voiceBitrateKbps !== undefined) body.voice_bitrate_kbps = voiceBitrateKbps
  if (profanityFilterEnabled !== undefined) body.profanity_filter_enabled = profanityFilterEnabled
  if (blockedWords !== undefined) body.blocked_words = blockedWords
  const res = await client(serverUrl).patch('/api/server/settings', body)
  return res.data as ServerInfo
}

export async function uploadServerBackground(
  serverUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const formData = new FormData()
  formData.append('file', file)

  const norm = normalizeUrl(serverUrl)
  const token = tokenStore.get(norm)

  if (onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${norm}/api/server/background`)
      xhr.withCredentials = true
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve()
        } else {
          let message = 'Upload failed'
          try { const err = JSON.parse(xhr.responseText); message = err.error || message } catch { /* ignore */ }
          reject(new Error(message))
        }
      }
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.send(formData)
    })
  }

  await client(serverUrl).post('/api/server/background', formData)
}

export async function deleteServerBackground(
  serverUrl: string,
): Promise<void> {
  await client(serverUrl).delete('/api/server/background')
}

// ─── Invites ──────────────────────────────────────────────

export async function createInvite(
  serverUrl: string,
  maxUses?: number,
  expiresInHours?: number,
): Promise<InviteCode> {
  const res = await client(serverUrl).post('/api/server/invites', {
    maxUses: maxUses || null,
    expiresInHours: expiresInHours || null,
  })
  return res.data
}

export async function fetchInvites(
  serverUrl: string,
): Promise<InviteCode[]> {
  const res = await client(serverUrl).get('/api/server/invites')
  return res.data.invites ?? res.data
}

export async function revokeInvite(
  serverUrl: string,
  code: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/server/invites/${code}`)
}

// ─── Member Management ────────────────────────────────────

export async function setMemberRole(
  serverUrl: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await client(serverUrl).patch(`/api/server/members/${userId}/role`, { role })
}

export async function kickMember(
  serverUrl: string,
  userId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/server/members/${userId}`)
}

export async function addMemberRole(
  serverUrl: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await client(serverUrl).post(`/api/server/members/${userId}/roles`, { roleId })
}

export async function removeMemberRole(
  serverUrl: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/server/members/${userId}/roles/${roleId}`)
}

export async function banUser(
  serverUrl: string,
  userId: string,
  reason?: string,
): Promise<void> {
  await client(serverUrl).post(`/api/bans/${userId}`, { reason: reason ?? null })
}

export async function unbanUser(
  serverUrl: string,
  userId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/bans/${userId}`)
}

// ─── Roles ────────────────────────────────────────────────

export async function fetchRoles(
  serverUrl: string,
): Promise<CustomRole[]> {
  const res = await client(serverUrl).get('/api/roles')
  return res.data.roles ?? res.data
}

export async function createRole(
  serverUrl: string,
  name: string,
  color: string,
  permissions: Partial<Record<Permission, boolean>>,
  hoist?: boolean,
  mentionable?: boolean,
  defaultOnJoin?: boolean,
): Promise<CustomRole> {
  const res = await client(serverUrl).post('/api/roles', {
    name,
    color,
    permissions,
    hoist,
    mentionable,
    default_on_join: defaultOnJoin,
  })
  return res.data.role ?? res.data
}

export async function updateRole(
  serverUrl: string,
  id: string,
  name: string,
  color: string,
  permissions: Partial<Record<Permission, boolean>>,
  hoist?: boolean,
  mentionable?: boolean,
  defaultOnJoin?: boolean,
): Promise<CustomRole> {
  const res = await client(serverUrl).patch(`/api/roles/${id}`, {
    name,
    color,
    permissions,
    hoist,
    mentionable,
    default_on_join: defaultOnJoin,
  })
  return res.data.role ?? res.data
}

export async function deleteRole(
  serverUrl: string,
  id: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/roles/${id}`)
}

export async function reorderRoles(
  serverUrl: string,
  order: { id: string; position: number }[],
): Promise<void> {
  await client(serverUrl).patch('/api/roles/reorder', { order })
}

// ─── Invite Join ──────────────────────────────────────────

export async function joinWithInvite(
  serverUrl: string,
  code: string,
): Promise<{ ok: boolean; alreadyMember: boolean }> {
  const res = await axios.post(
    `${normalizeUrl(serverUrl)}/api/server/join/${code.toUpperCase()}`,
    {},
    { withCredentials: true },
  )
  return res.data
}

// ─── Direct Messages ──────────────────────────────────────

export async function fetchDMChannels(
  serverUrl: string,
): Promise<DMChannelData[]> {
  const res = await client(serverUrl).get('/api/dms')
  return res.data.channels ?? res.data
}

export async function getOrCreateDMChannel(
  serverUrl: string,
  userId: string,
): Promise<DMChannelData> {
  const res = await client(serverUrl).get(`/api/dms/${userId}`)
  return res.data.channel
}

export async function fetchDMMessages(
  serverUrl: string,
  channelId: string,
  limit = 50,
  before?: string,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const params: Record<string, string | number> = { limit }
  if (before) params.before = before
  const res = await client(serverUrl).get(
    `/api/dms/channel/${channelId}/messages`,
    { params },
  )
  return { messages: res.data.messages ?? res.data, hasMore: res.data.hasMore ?? false }
}

export async function sendDMMessage(
  serverUrl: string,
  channelId: string,
  content: string,
  encrypted?: boolean,
  attachmentIds?: string[],
): Promise<Message> {
  const res = await client(serverUrl).post(
    `/api/dms/channel/${channelId}/messages`,
    { content, encrypted: encrypted || false, ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}) },
  )
  return res.data.message ?? res.data
}

export async function editDMMessage(
  serverUrl: string,
  messageId: string,
  content: string,
  encrypted?: boolean,
): Promise<Message> {
  const res = await client(serverUrl).patch(`/api/dms/messages/${messageId}`, { content, encrypted: encrypted || false })
  return res.data.message ?? res.data
}

export async function deleteDMMessage(
  serverUrl: string,
  messageId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/dms/messages/${messageId}`)
}

// ─── Group DMs ──────────────────────────────────────────

export async function fetchGroupDMChannels(
  serverUrl: string,
): Promise<GroupDMChannelData[]> {
  const res = await client(serverUrl).get('/api/group-dms')
  return res.data.channels ?? res.data
}

export async function createGroupDM(
  serverUrl: string,
  name: string,
  memberIds: string[],
): Promise<GroupDMChannelData> {
  const res = await client(serverUrl).post('/api/group-dms', { name, memberIds })
  return res.data.channel ?? res.data
}

export async function getGroupDMChannel(
  serverUrl: string,
  channelId: string,
): Promise<GroupDMChannelData> {
  const res = await client(serverUrl).get(`/api/group-dms/${channelId}`)
  return res.data.channel ?? res.data
}

export async function updateGroupDM(
  serverUrl: string,
  channelId: string,
  data: { name?: string; avatar?: string | null },
): Promise<GroupDMChannelData> {
  const res = await client(serverUrl).patch(`/api/group-dms/${channelId}`, data)
  return res.data.channel ?? res.data
}

export async function fetchGroupDMMessages(
  serverUrl: string,
  channelId: string,
  limit = 50,
  before?: string,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const params: Record<string, string | number> = { limit }
  if (before) params.before = before
  const res = await client(serverUrl).get(
    `/api/group-dms/${channelId}/messages`,
    { params },
  )
  return { messages: res.data.messages ?? res.data, hasMore: res.data.hasMore ?? false }
}

export async function sendGroupDMMessage(
  serverUrl: string,
  channelId: string,
  content: string,
  encrypted?: boolean,
  attachmentIds?: string[],
): Promise<Message> {
  const res = await client(serverUrl).post(
    `/api/group-dms/${channelId}/messages`,
    { content, encrypted: encrypted || false, ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}) },
  )
  return res.data.message ?? res.data
}

export async function editGroupDMMessage(
  serverUrl: string,
  messageId: string,
  content: string,
  encrypted?: boolean,
): Promise<Message> {
  const res = await client(serverUrl).patch(`/api/group-dms/messages/${messageId}`, { content, encrypted: encrypted || false })
  return res.data.message ?? res.data
}

export async function deleteGroupDMMessage(
  serverUrl: string,
  messageId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/group-dms/messages/${messageId}`)
}

export async function addGroupDMMember(
  serverUrl: string,
  channelId: string,
  userId: string,
): Promise<GroupDMChannelData> {
  const res = await client(serverUrl).post(`/api/group-dms/${channelId}/members`, { userId })
  return res.data.channel ?? res.data
}

export async function removeGroupDMMember(
  serverUrl: string,
  channelId: string,
  userId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/group-dms/${channelId}/members/${userId}`)
}

// ─── Attachments ──────────────────────────────────────────

export async function uploadAttachment(
  serverUrl: string,
  channelId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<FileAttachment> {
  const formData = new FormData()
  formData.append('file', file)

  if (onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${normalizeUrl(serverUrl)}/api/attachments/${channelId}`)
      xhr.withCredentials = true
      const norm = normalizeUrl(serverUrl)
      const token = tokenStore.get(norm)
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100))
        }
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText)
            resolve(data.attachment)
          } catch {
            reject(new Error('Invalid response'))
          }
        } else {
          let message = 'Upload failed'
          try { const err = JSON.parse(xhr.responseText); message = err.error || message } catch { /* ignore */ }
          reject(new Error(message))
        }
      }
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.send(formData)
    })
  }

  const res = await client(serverUrl).post(`/api/attachments/${channelId}`, formData)
  return res.data.attachment
}

export async function fetchAttachments(
  serverUrl: string,
  messageId: string,
): Promise<FileAttachment[]> {
  const res = await client(serverUrl).get(`/api/attachments/message/${messageId}`)
  return res.data.attachments ?? res.data
}

// ─── Channel Mutes ─────────────────────────────────────────

export async function fetchChannelMutes(
  serverUrl: string,
): Promise<ChannelMute[]> {
  const res = await client(serverUrl).get('/api/mutes')
  return res.data.mutes ?? res.data
}

export async function setChannelMute(
  serverUrl: string,
  channelId: string,
  mutedUntil: number | null,
): Promise<ChannelMute> {
  const res = await client(serverUrl).put(`/api/mutes/${channelId}`, { muted_until: mutedUntil })
  return res.data.mute ?? res.data
}

export async function deleteChannelMute(
  serverUrl: string,
  channelId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/mutes/${channelId}`)
}

// ─── GIFs & Stickers ─────────────────────────────────────

export async function fetchGifs(
  serverUrl: string,
  params?: { type?: 'gif' | 'sticker'; category?: string; pack?: string; search?: string; limit?: number; offset?: number },
): Promise<GifInfo[]> {
  const res = await client(serverUrl).get('/api/gifs', { params })
  return res.data.gifs ?? res.data
}

export async function fetchGifCategories(
  serverUrl: string,
  type?: 'gif' | 'sticker',
): Promise<string[]> {
  const res = await client(serverUrl).get('/api/gifs/categories', { params: type ? { type } : {} })
  return res.data.categories ?? res.data
}

export async function fetchStickerPacks(
  serverUrl: string,
): Promise<string[]> {
  const res = await client(serverUrl).get('/api/gifs/packs')
  return res.data.packs ?? res.data
}

export async function uploadGif(
  serverUrl: string,
  file: File,
  displayName: string,
  category?: string,
  tags?: string,
): Promise<GifInfo> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('display_name', displayName)
  if (category) formData.append('category', category)
  if (tags) formData.append('tags', tags)

  const res = await client(serverUrl).post('/api/gifs/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function uploadGifPack(
  serverUrl: string,
  file: File,
): Promise<{ imported: number }> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await client(serverUrl).post('/api/gifs/pack', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function uploadStickerPack(
  serverUrl: string,
  file: File,
  packName: string,
): Promise<{ imported: number }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('pack_name', packName)

  const res = await client(serverUrl).post('/api/gifs/sticker-pack', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function uploadSticker(
  serverUrl: string,
  file: File,
  packName: string,
  displayName?: string,
): Promise<GifInfo> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('pack_name', packName)
  if (displayName) formData.append('display_name', displayName)

  const res = await client(serverUrl).post('/api/gifs/sticker', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function updateGif(
  serverUrl: string,
  gifId: string,
  data: { display_name?: string; category?: string; tags?: string; suggested_tags?: string },
): Promise<GifInfo> {
  const res = await client(serverUrl).patch(`/api/gifs/${gifId}`, data)
  return res.data
}

export async function deleteGif(
  serverUrl: string,
  gifId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/gifs/${gifId}`)
}

export async function generateGifTags(
  serverUrl: string,
  gifId: string,
): Promise<GifInfo> {
  const res = await client(serverUrl).post(`/api/gifs/${gifId}/generate-tags`)
  return res.data
}

export async function loadTagger(
  serverUrl: string,
): Promise<{ message: string }> {
  const res = await client(serverUrl).post('/api/gifs/load-tagger')
  return res.data
}

export async function unloadTagger(
  serverUrl: string,
): Promise<{ message: string }> {
  const res = await client(serverUrl).post('/api/gifs/unload-tagger')
  return res.data
}

export async function getTaggerStatus(
  serverUrl: string,
): Promise<TaggerStatus> {
  const res = await client(serverUrl).get('/api/gifs/tagger-status')
  return res.data
}

export async function deleteStickerPack(
  serverUrl: string,
  packName: string,
): Promise<{ ok: boolean; deleted: number }> {
  const res = await client(serverUrl).delete(`/api/gifs/pack/${encodeURIComponent(packName)}`)
  return res.data
}

// ─── Reactions ─────────────────────────────────────────

export async function reactToMessage(
  serverUrl: string,
  messageId: string,
  reactionKey: string,
  reactionType: string = 'emoji',
): Promise<{ reactions: import('./types').MessageReaction[] }> {
  const res = await client(serverUrl).post(`/api/reactions/${messageId}`, {
    reaction_key: reactionKey,
    reaction_type: reactionType,
  })
  return res.data
}

export async function unreactToMessage(
  serverUrl: string,
  messageId: string,
  reactionKey: string,
): Promise<{ reactions: import('./types').MessageReaction[] }> {
  const res = await client(serverUrl).delete(`/api/reactions/${messageId}/${encodeURIComponent(reactionKey)}`)
  return res.data
}

export async function fetchPopularReactions(
  serverUrl: string,
): Promise<{ emojis: string[]; stickers: { id: string; url: string }[] }> {
  const res = await client(serverUrl).get('/api/reactions/popular')
  return res.data
}

export async function searchMessages(
  serverUrl: string,
  query: string,
  channelId?: string,
  limit = 20,
  before?: string,
): Promise<{ results: { message: Message; channelName: string }[]; hasMore: boolean }> {
  const params: Record<string, string | number> = { query, limit }
  if (channelId) params.channelId = channelId
  if (before) params.before = before
  const res = await client(serverUrl).get('/api/search', { params })
  return { results: res.data.results ?? [], hasMore: res.data.hasMore ?? false }
}

export async function fetchPinnedMessages(
  serverUrl: string,
  channelId: string,
): Promise<Message[]> {
  const res = await client(serverUrl).get(`/api/pins/${channelId}`)
  return res.data.pins ?? []
}

export async function pinMessage(
  serverUrl: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await client(serverUrl).post(`/api/pins/${channelId}/${messageId}`)
}

export async function unpinMessage(
  serverUrl: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/pins/${channelId}/${messageId}`)
}

export async function fetchCategories(
  serverUrl: string,
): Promise<{ id: string; name: string; position: number }[]> {
  const res = await client(serverUrl).get('/api/categories')
  return res.data.categories ?? []
}

export async function createCategory(
  serverUrl: string,
  name: string,
): Promise<{ id: string; name: string; position: number }> {
  const res = await client(serverUrl).post('/api/categories', { name })
  return res.data
}

export async function updateCategory(
  serverUrl: string,
  categoryId: string,
  name: string,
): Promise<void> {
  await client(serverUrl).patch(`/api/categories/${categoryId}`, { name })
}

export async function deleteCategory(
  serverUrl: string,
  categoryId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/categories/${categoryId}`)
}

export async function unfurlUrls(
  serverUrl: string,
  urls: string[],
): Promise<Record<string, LinkEmbed>> {
  const res = await client(serverUrl).post('/api/embeds/unfurl', { urls })
  return res.data.embeds ?? {}
}

export async function fetchThreads(
  serverUrl: string,
  channelId: string,
): Promise<Thread[]> {
  const res = await client(serverUrl).get(`/api/threads/${channelId}`)
  return res.data.threads ?? []
}

export async function createThread(
  serverUrl: string,
  channelId: string,
  name?: string,
  messageId?: string,
): Promise<{ id: string }> {
  const res = await client(serverUrl).post(`/api/threads/${channelId}`, { name, message_id: messageId })
  return res.data
}

export async function fetchThreadMessages(
  serverUrl: string,
  channelId: string,
  threadId: string,
  limit = 50,
  before?: string,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const params: Record<string, string | number> = { limit }
  if (before) params.before = before
  const res = await client(serverUrl).get(`/api/threads/${channelId}/${threadId}/messages`, { params })
  return { messages: res.data.messages ?? [], hasMore: res.data.hasMore ?? false }
}

export async function sendThreadMessage(
  serverUrl: string,
  channelId: string,
  threadId: string,
  content: string,
): Promise<Message> {
  const res = await client(serverUrl).post(`/api/threads/${channelId}/${threadId}/messages`, { content })
  return res.data.message ?? res.data
}

export async function deleteThread(
  serverUrl: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/threads/${channelId}/${threadId}`)
}

// Polls
export async function createPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/channels/${channelId}/polls`, { question, options })
  return res.data
}

export async function createDMPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/dms/channel/${channelId}/polls`, { question, options })
  return res.data
}

export async function createGroupDMPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/group-dms/${channelId}/polls`, { question, options })
  return res.data
}

export async function fetchPoll(
  serverUrl: string,
  pollId: string,
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number; vote_count: number }[]; userVoteIds: string[] } }> {
  const res = await client(serverUrl).get(`/api/polls/${pollId}`)
  return res.data
}

export async function votePoll(
  serverUrl: string,
  pollId: string,
  optionId: string,
): Promise<{ options: { id: string; label: string; position: number; vote_count: number }[]; userVoteIds: string[] }> {
  const res = await client(serverUrl).post(`/api/polls/${pollId}/vote`, { optionId })
  return res.data
}

export async function deletePoll(
  serverUrl: string,
  pollId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/polls/${pollId}`)
}

// Webhooks
export async function createWebhook(
  serverUrl: string,
  channelId: string,
  name: string,
): Promise<{ webhook: { id: string; channelId: string; name: string; token: string } }> {
  const res = await client(serverUrl).post(`/api/channels/${channelId}/webhooks`, { name })
  return res.data
}

export async function fetchWebhooks(
  serverUrl: string,
  channelId: string,
): Promise<{ webhooks: { id: string; name: string; token: string; channel_id: string; created_at: number }[] }> {
  const res = await client(serverUrl).get(`/api/channels/${channelId}/webhooks`)
  return res.data
}

export async function updateWebhook(
  serverUrl: string,
  webhookId: string,
  data: { name?: string; avatar?: string | null },
): Promise<{ webhook: { id: string; name: string; avatar: string | null; token: string; channel_id: string; created_at: number } }> {
  const res = await client(serverUrl).patch(`/api/webhooks/${webhookId}`, data)
  return res.data
}

export async function deleteWebhook(
  serverUrl: string,
  webhookId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/webhooks/${webhookId}`)
}

// ─── Storage & Cleanup ──────────────────────────────────────

export async function fetchStorageStats(
  serverUrl: string,
): Promise<{
  attachments: { count: number; totalSize: number }
  gifs: { count: number; totalSize: number }
  auditLogs: { count: number }
  orphans: { count: number; totalSize: number }
  dbSize: number
}> {
  const res = await client(serverUrl).get('/api/server/storage')
  return res.data
}

export async function clearAuditLogs(
  serverUrl: string,
): Promise<void> {
  await client(serverUrl).delete('/api/audit')
}

export async function cleanupOrphanFiles(
  serverUrl: string,
): Promise<{ deletedCount: number; freedBytes: number }> {
  const res = await client(serverUrl).post('/api/server/cleanup/orphans')
  return res.data
}

// ─── Identity Linking ─────────────────────────────────────

export async function initiateIdentityLink(
  serverUrl: string,
): Promise<{ nonce: string; expiresAt: number }> {
  const res = await client(serverUrl).post('/api/auth/identity-link/initiate')
  return res.data
}

export async function confirmIdentityLink(
  serverUrl: string,
  requestingServer: string,
  nonce: string,
): Promise<{ verificationToken: string }> {
  const res = await client(serverUrl).post('/api/auth/identity-link/confirm', {
    requestingServer,
    nonce,
  })
  return res.data
}

export async function completeIdentityLink(
  serverUrl: string,
  linkedServerUrl: string,
  verificationToken: string,
): Promise<LinkedIdentity> {
  const res = await client(serverUrl).post('/api/auth/identity-link/complete', {
    linkedServerUrl,
    verificationToken,
  })
  return res.data.linked_identity
}

export async function getLinkedIdentities(
  serverUrl: string,
): Promise<LinkedIdentity[]> {
  const res = await client(serverUrl).get('/api/auth/identity-links')
  return res.data.linked_identities ?? []
}

export async function setLinkedIdentityPublic(
  serverUrl: string,
  linkId: string,
  isPublic: boolean,
): Promise<void> {
  await client(serverUrl).patch(`/api/auth/identity-links/${linkId}/public`, {
    public: isPublic,
  })
}

export async function unlinkIdentity(
  serverUrl: string,
  linkId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/auth/identity-links/${linkId}`)
}
