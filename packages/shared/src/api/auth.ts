import axios from 'axios'
import type {
  User,
  ServerInfo,
  PoWChallenge,
  AdminInfo,
  PublicServerEntry,
} from '../types'
import { client, normalizeUrl } from './core'

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

export async function deleteAccount(
  serverUrl: string,
  password: string,
  deleteData = false,
): Promise<void> {
  await client(serverUrl).delete('/api/auth/me', {
    data: { password },
    params: { data: deleteData ? 'true' : 'false' },
  })
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

