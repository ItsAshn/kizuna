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
  FileAttachment,
} from './types'

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function client(baseUrl: string, token?: string) {
  return axios.create({
    baseURL: normalizeUrl(baseUrl),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

// ─── Auth ─────────────────────────────────────────────────

export async function register(
  serverUrl: string,
  username: string,
  password: string,
  display_name?: string,
  serverPassword?: string,
  public_key?: string,
): Promise<{ token: string; user: User }> {
  const res = await axios.post(`${normalizeUrl(serverUrl)}/api/auth/register`, {
    username,
    password,
    display_name: display_name || username,
    ...(serverPassword ? { serverPassword } : {}),
    ...(public_key ? { public_key } : {}),
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

export async function getMe(serverUrl: string, token: string): Promise<User> {
  const res = await axios.get(`${normalizeUrl(serverUrl)}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.data
}

export async function uploadPublicKey(
  serverUrl: string,
  token: string,
  publicKey: string,
): Promise<void> {
  await client(serverUrl, token).put('/api/auth/public-key', { public_key: publicKey })
}

export async function getUserPublicKey(
  serverUrl: string,
  token: string,
  userId: string,
): Promise<string | null> {
  const res = await client(serverUrl, token).get(`/api/auth/users/${userId}/public-key`)
  return res.data.public_key ?? null
}

export async function fetchServerInfo(serverUrl: string) {
  const res = await axios.get(`${normalizeUrl(serverUrl)}/api/server/info`, {
    timeout: 8000,
  })
  return res.data as {
    name: string
    description: string
    passwordProtected: boolean
    icon: string | null
  }
}

export async function resolveInviteCode(
  code: string,
): Promise<{ serverUrl: string; name: string; description: string }> {
  const parts = code.toUpperCase().split('.')
  if (parts.length !== 2) throw new Error('Invalid invite code format')
  const [encodedUrl] = parts
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
  token: string,
): Promise<Channel[]> {
  const res = await client(serverUrl, token).get('/api/channels')
  return res.data.channels ?? res.data
}

export async function createChannel(
  serverUrl: string,
  token: string,
  name: string,
  type: 'text' | 'voice',
): Promise<Channel> {
  const res = await client(serverUrl, token).post('/api/channels', { name, type })
  return res.data.channel ?? res.data
}

export async function deleteChannel(
  serverUrl: string,
  token: string,
  id: string,
): Promise<void> {
  await client(serverUrl, token).delete(`/api/channels/${id}`)
}

// ─── Messages ─────────────────────────────────────────────

export async function fetchMessages(
  serverUrl: string,
  token: string,
  channelId: string,
  limit = 50,
): Promise<Message[]> {
  const res = await client(serverUrl, token).get(`/api/messages/${channelId}`, {
    params: { limit },
  })
  return res.data.messages ?? res.data
}

export async function sendMessage(
  serverUrl: string,
  token: string,
  channelId: string,
  content: string,
): Promise<Message> {
  const res = await client(serverUrl, token).post(`/api/messages/${channelId}`, { content })
  return res.data.message ?? res.data
}

export async function deleteMessage(
  serverUrl: string,
  token: string,
  messageId: string,
): Promise<void> {
  await client(serverUrl, token).delete(`/api/messages/${messageId}`)
}

export async function editMessage(
  serverUrl: string,
  token: string,
  messageId: string,
  content: string,
): Promise<Message> {
  const res = await client(serverUrl, token).patch(`/api/messages/${messageId}`, { content })
  return res.data.message ?? res.data
}

// ─── Members ──────────────────────────────────────────────

export async function fetchMembers(
  serverUrl: string,
  token: string,
): Promise<Member[]> {
  const res = await client(serverUrl, token).get('/api/auth/users')
  return res.data.users ?? res.data
}

// ─── Profile ──────────────────────────────────────────────

export async function updateProfile(
  serverUrl: string,
  token: string,
  display_name?: string,
  avatar?: string | null,
): Promise<User> {
  const res = await client(serverUrl, token).patch('/api/auth/profile', {
    display_name,
    avatar,
  })
  return res.data.user ?? res.data
}

// ─── Server Settings ──────────────────────────────────────

export async function updateServerSettings(
  serverUrl: string,
  token: string,
  name: string,
  icon?: string | null,
): Promise<{ name: string; icon: string | null }> {
  const res = await client(serverUrl, token).patch('/api/server/settings', { name, icon })
  return res.data
}

// ─── Invites ──────────────────────────────────────────────

export async function createInvite(
  serverUrl: string,
  token: string,
  maxUses?: number,
  expiresInHours?: number,
): Promise<InviteCode> {
  const res = await client(serverUrl, token).post('/api/server/invites', {
    maxUses: maxUses || null,
    expiresInHours: expiresInHours || null,
  })
  return res.data
}

export async function fetchInvites(
  serverUrl: string,
  token: string,
): Promise<InviteCode[]> {
  const res = await client(serverUrl, token).get('/api/server/invites')
  return res.data.invites ?? res.data
}

export async function revokeInvite(
  serverUrl: string,
  token: string,
  code: string,
): Promise<void> {
  await client(serverUrl, token).delete(`/api/server/invites/${code}`)
}

// ─── Member Management ────────────────────────────────────

export async function setMemberRole(
  serverUrl: string,
  token: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await client(serverUrl, token).patch(`/api/server/members/${userId}/role`, { role })
}

export async function kickMember(
  serverUrl: string,
  token: string,
  userId: string,
): Promise<void> {
  await client(serverUrl, token).delete(`/api/server/members/${userId}`)
}

export async function assignCustomRole(
  serverUrl: string,
  token: string,
  userId: string,
  roleId: string | null,
): Promise<void> {
  await client(serverUrl, token).patch(`/api/server/members/${userId}/custom-role`, { roleId })
}

// ─── Roles ────────────────────────────────────────────────

export async function fetchRoles(
  serverUrl: string,
  token: string,
): Promise<CustomRole[]> {
  const res = await client(serverUrl, token).get('/api/roles')
  return res.data.roles ?? res.data
}

export async function createRole(
  serverUrl: string,
  token: string,
  name: string,
  color: string,
  permissions: Partial<Record<Permission, boolean>>,
): Promise<CustomRole> {
  const res = await client(serverUrl, token).post('/api/roles', {
    name,
    color,
    permissions,
  })
  return res.data.role ?? res.data
}

export async function updateRole(
  serverUrl: string,
  token: string,
  id: string,
  name: string,
  color: string,
  permissions: Partial<Record<Permission, boolean>>,
): Promise<CustomRole> {
  const res = await client(serverUrl, token).patch(`/api/roles/${id}`, {
    name,
    color,
    permissions,
  })
  return res.data.role ?? res.data
}

export async function deleteRole(
  serverUrl: string,
  token: string,
  id: string,
): Promise<void> {
  await client(serverUrl, token).delete(`/api/roles/${id}`)
}

// ─── Invite Join ──────────────────────────────────────────

export async function joinWithInvite(
  serverUrl: string,
  token: string | undefined,
  code: string,
): Promise<{ ok: boolean; alreadyMember: boolean }> {
  const res = await axios.post(
    `${normalizeUrl(serverUrl)}/api/server/join/${code.toUpperCase()}`,
    {},
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  )
  return res.data
}

// ─── Direct Messages ──────────────────────────────────────

export async function fetchDMChannels(
  serverUrl: string,
  token: string,
): Promise<DMChannelData[]> {
  const res = await client(serverUrl, token).get('/api/dms')
  return res.data.channels ?? res.data
}

export async function getOrCreateDMChannel(
  serverUrl: string,
  token: string,
  userId: string,
): Promise<DMChannelData> {
  const res = await client(serverUrl, token).get(`/api/dms/${userId}`)
  return res.data.channel
}

export async function fetchDMMessages(
  serverUrl: string,
  token: string,
  channelId: string,
  limit = 50,
): Promise<Message[]> {
  const res = await client(serverUrl, token).get(
    `/api/dms/channel/${channelId}/messages`,
    { params: { limit } },
  )
  return res.data.messages ?? res.data
}

export async function sendDMMessage(
  serverUrl: string,
  token: string,
  channelId: string,
  content: string,
  encrypted?: boolean,
): Promise<Message> {
  const res = await client(serverUrl, token).post(
    `/api/dms/channel/${channelId}/messages`,
    { content, encrypted: encrypted || false },
  )
  return res.data.message ?? res.data
}

// ─── Attachments ──────────────────────────────────────────

export async function uploadAttachment(
  serverUrl: string,
  token: string,
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

  const response = await fetch(`${normalizeUrl(serverUrl)}/api/attachments/${channelId}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }))
    throw new Error(error.error || 'Upload failed')
  }

  const data = await response.json()
  return data.attachment
}

export async function fetchAttachments(
  serverUrl: string,
  token: string,
  messageId: string,
): Promise<FileAttachment[]> {
  const res = await client(serverUrl, token).get(`/api/attachments/message/${messageId}`)
  return res.data.attachments ?? res.data
}
