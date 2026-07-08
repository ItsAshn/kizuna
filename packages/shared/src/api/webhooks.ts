import { client } from './core'

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

