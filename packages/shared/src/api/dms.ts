import type {
  Message,
  DMChannelData,
  GroupDMChannelData,
} from '../types'
import { client } from './core'

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

