import axios from 'axios'
import type {
  InviteCode,
  ServerInfo,
} from '../types'
import { client, normalizeUrl, tokenStore } from './core'

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

