import type {
  Channel,
  ChannelMute,
} from '../types'
import { client } from './core'

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

