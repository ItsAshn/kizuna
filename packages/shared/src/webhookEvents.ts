import type { OutgoingWebhookEvent, OutgoingWebhookFormat } from './types'

// Re-exported so consumers of the `@kizuna/shared/webhook-events` subpath (the
// server, which cannot import the axios-laden package root) get the types too.
export type { OutgoingWebhookEvent, OutgoingWebhookFormat }

/**
 * The subscribable events, in the order the settings UI lists them. The server
 * validates against this same list, so adding an event here is the only place
 * the name needs to be written down.
 */
export const OUTGOING_WEBHOOK_EVENTS: {
  key: OutgoingWebhookEvent
  label: string
  desc: string
  /** Fires per-channel, so a channel-scoped webhook can receive it. */
  channelScoped: boolean
}[] = [
  { key: 'message.created', label: 'message sent', desc: 'A message was posted in a channel', channelScoped: true },
  { key: 'message.updated', label: 'message edited', desc: 'A message was edited', channelScoped: true },
  { key: 'message.deleted', label: 'message deleted', desc: 'A message was deleted', channelScoped: true },
  { key: 'channel.created', label: 'channel created', desc: 'A channel was created', channelScoped: false },
  { key: 'channel.updated', label: 'channel updated', desc: 'A channel was renamed or reconfigured', channelScoped: true },
  { key: 'channel.deleted', label: 'channel deleted', desc: 'A channel was deleted', channelScoped: true },
  { key: 'member.joined', label: 'member joined', desc: 'Someone joined the server', channelScoped: false },
  { key: 'member.left', label: 'member left', desc: 'Someone left the server on their own', channelScoped: false },
  { key: 'member.removed', label: 'member removed', desc: 'Someone was kicked or banned', channelScoped: false },
]

const EVENT_KEYS = new Set<string>(OUTGOING_WEBHOOK_EVENTS.map((e) => e.key))

export function isOutgoingWebhookEvent(value: unknown): value is OutgoingWebhookEvent {
  return typeof value === 'string' && EVENT_KEYS.has(value)
}

/** Events a channel-scoped webhook is allowed to subscribe to. */
export function isChannelScopedEvent(event: OutgoingWebhookEvent): boolean {
  return OUTGOING_WEBHOOK_EVENTS.find((e) => e.key === event)?.channelScoped ?? false
}

/**
 * Everything an event carries. Deliberately one flat optional-field shape
 * rather than a discriminated union per event — the emit sites have genuinely
 * different data available, and a union would push that variance onto every
 * call site for no gain.
 */
export interface OutgoingWebhookEventData {
  channel?: { id: string; name?: string | null } | null
  message?: {
    id: string
    content?: string | null
    /** Set when the message itself came from an incoming webhook. */
    webhook_id?: string | null
  } | null
  user?: { id?: string | null; username?: string | null; display_name?: string | null } | null
  /** Who performed the action, when that differs from `user` (kicks, bans). */
  actor?: { id?: string | null; username?: string | null } | null
  reason?: string | null
}

/** Discord rejects bodies over 2000 chars; leave headroom for the wrapper. */
export const MAX_RENDERED_TEXT = 1900

export function truncateText(text: string, max = MAX_RENDERED_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function channelRef(data: OutgoingWebhookEventData): string {
  const name = data.channel?.name
  return name ? `**#${name}**` : '**a channel**'
}

function userRef(user: OutgoingWebhookEventData['user']): string {
  return user?.username ? `@${user.username}` : 'someone'
}

/**
 * Renders an event as human-readable markdown for the `discord` and `slack`
 * formats. The `kizuna` format sends structured JSON instead and never calls
 * this.
 */
export function renderEventText(
  event: OutgoingWebhookEvent | 'ping',
  data: OutgoingWebhookEventData,
): string {
  const who = userRef(data.user)
  const where = channelRef(data)

  switch (event) {
    case 'ping':
      return '✅ Test delivery from Kizuna — this webhook is configured correctly.'
    case 'message.created':
      return truncateText(`${where} · ${who}: ${data.message?.content ?? ''}`.trimEnd())
    case 'message.updated':
      return truncateText(`✏️ ${where} · ${who} edited a message: ${data.message?.content ?? ''}`.trimEnd())
    case 'message.deleted':
      return truncateText(`🗑️ ${where} · a message was deleted`)
    case 'channel.created':
      return truncateText(`➕ Channel ${where} was created`)
    case 'channel.updated':
      return truncateText(`✏️ Channel ${where} was updated`)
    case 'channel.deleted':
      return truncateText(`➖ Channel ${where} was deleted`)
    case 'member.joined':
      return truncateText(`👋 ${who} joined the server`)
    case 'member.left':
      return truncateText(`🚪 ${who} left the server`)
    case 'member.removed':
      return truncateText(
        `🚫 ${who} was removed from the server${data.reason ? ` — ${data.reason}` : ''}`,
      )
    default:
      return truncateText(`Kizuna event: ${event as string}`)
  }
}

/**
 * The string an outgoing webhook's signature is computed over. The timestamp is
 * inside the signed material so a receiver can reject replayed deliveries — it
 * is sent alongside in `X-Kizuna-Timestamp`.
 *
 * Receivers verify with:
 *   hmac_sha256(secret, `${X-Kizuna-Timestamp}.${rawBody}`) === X-Kizuna-Signature minus the "sha256=" prefix
 */
export function webhookSignatureBase(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`
}

export const WEBHOOK_SIGNATURE_PREFIX = 'sha256='
