import { client, normalizeUrl } from './core'
import type { Webhook } from '../types'

/** The public URL an external service POSTs to in order to post a message. */
export function webhookUrl(serverUrl: string, token: string): string {
  return `${normalizeUrl(serverUrl)}/api/webhooks/incoming/${token}`
}

export async function createWebhook(
  serverUrl: string,
  channelId: string,
  name: string,
  avatar?: string | null,
): Promise<Webhook> {
  const res = await client(serverUrl).post(`/api/channels/${channelId}/webhooks`, { name, avatar })
  return res.data.webhook
}

export async function fetchWebhooks(serverUrl: string, channelId: string): Promise<Webhook[]> {
  const res = await client(serverUrl).get(`/api/channels/${channelId}/webhooks`)
  return res.data.webhooks
}

/** Every webhook the current user is allowed to manage, across all channels. */
export async function fetchAllWebhooks(serverUrl: string): Promise<Webhook[]> {
  const res = await client(serverUrl).get('/api/webhooks')
  return res.data.webhooks
}

export async function updateWebhook(
  serverUrl: string,
  webhookId: string,
  data: { name?: string; avatar?: string | null },
): Promise<Webhook> {
  const res = await client(serverUrl).patch(`/api/webhooks/${webhookId}`, data)
  return res.data.webhook
}

/** Rotates the token, invalidating the old URL. */
export async function regenerateWebhookToken(serverUrl: string, webhookId: string): Promise<Webhook> {
  const res = await client(serverUrl).post(`/api/webhooks/${webhookId}/regenerate`)
  return res.data.webhook
}

export async function deleteWebhook(serverUrl: string, webhookId: string): Promise<void> {
  await client(serverUrl).delete(`/api/webhooks/${webhookId}`)
}
