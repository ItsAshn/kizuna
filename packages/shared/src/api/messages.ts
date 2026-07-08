import type {
  Message,
  LinkEmbed,
  Thread,
} from '../types'
import { client } from './core'

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

// ─── Reactions ─────────────────────────────────────────

export async function reactToMessage(
  serverUrl: string,
  messageId: string,
  reactionKey: string,
  reactionType: string = 'emoji',
): Promise<{ reactions: import('../types').MessageReaction[] }> {
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
): Promise<{ reactions: import('../types').MessageReaction[] }> {
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
