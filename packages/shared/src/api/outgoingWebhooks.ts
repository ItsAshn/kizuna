import { client } from './core'
import type {
  OutgoingWebhook,
  OutgoingWebhookDelivery,
  OutgoingWebhookEvent,
  OutgoingWebhookFormat,
  OutgoingWebhookTestResult,
} from '../types'

/** Fields a caller may set when creating or updating an outgoing webhook. */
export interface OutgoingWebhookInput {
  name?: string
  url?: string
  events?: OutgoingWebhookEvent[]
  /** `null` = server-wide. */
  channel_id?: string | null
  format?: OutgoingWebhookFormat
  enabled?: boolean
  skip_webhook_messages?: boolean
}

/**
 * Every outgoing webhook the current user may manage. Pass `channelId` to scope
 * the list to one channel (channel settings) — omitted returns all of them.
 */
export async function fetchOutgoingWebhooks(
  serverUrl: string,
  channelId?: string,
): Promise<OutgoingWebhook[]> {
  const res = await client(serverUrl).get('/api/outgoing-webhooks', {
    params: channelId ? { channel_id: channelId } : undefined,
  })
  return res.data.webhooks
}

export async function createOutgoingWebhook(
  serverUrl: string,
  data: OutgoingWebhookInput,
): Promise<OutgoingWebhook> {
  const res = await client(serverUrl).post('/api/outgoing-webhooks', data)
  return res.data.webhook
}

export async function updateOutgoingWebhook(
  serverUrl: string,
  webhookId: string,
  data: OutgoingWebhookInput,
): Promise<OutgoingWebhook> {
  const res = await client(serverUrl).patch(`/api/outgoing-webhooks/${webhookId}`, data)
  return res.data.webhook
}

export async function deleteOutgoingWebhook(serverUrl: string, webhookId: string): Promise<void> {
  await client(serverUrl).delete(`/api/outgoing-webhooks/${webhookId}`)
}

/** Rotates the signing secret. Receivers verifying signatures must be updated. */
export async function regenerateOutgoingWebhookSecret(
  serverUrl: string,
  webhookId: string,
): Promise<OutgoingWebhook> {
  const res = await client(serverUrl).post(`/api/outgoing-webhooks/${webhookId}/regenerate`)
  return res.data.webhook
}

/** Sends a synthetic `ping` and waits for the real result. */
export async function testOutgoingWebhook(
  serverUrl: string,
  webhookId: string,
): Promise<OutgoingWebhookTestResult> {
  const res = await client(serverUrl).post(`/api/outgoing-webhooks/${webhookId}/test`)
  return res.data.result
}

export async function fetchOutgoingWebhookDeliveries(
  serverUrl: string,
  webhookId: string,
): Promise<OutgoingWebhookDelivery[]> {
  const res = await client(serverUrl).get(`/api/outgoing-webhooks/${webhookId}/deliveries`)
  return res.data.deliveries
}
