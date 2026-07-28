import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import {
  OUTGOING_WEBHOOK_EVENTS,
  isChannelScopedEvent,
  isOutgoingWebhookEvent,
  type OutgoingWebhookEvent,
} from '@kizuna/shared/webhook-events'
import { getDb } from '../db'
import { authMiddleware, requirePermission } from '../middleware/auth'
import { getAuth } from '../utils/auth'
import { logAuditEvent } from './audit'
import {
  deliverOnce,
  generateWebhookSecret,
  isSafeWebhookTarget,
  type OutgoingWebhookRow,
} from '../services/outgoingWebhooks'

const MAX_NAME = 80
const MAX_URL = 2048
const VALID_FORMATS = new Set(['kizuna', 'discord', 'slack'])
const DELIVERY_LIMIT = 20

const outgoingWebhookRoutes = new Hono()

const SELECT_WEBHOOK = `
  SELECT w.*, u.username AS created_by_username, c.name AS channel_name
  FROM outgoing_webhooks w
  LEFT JOIN users u ON u.id = w.created_by
  LEFT JOIN channels c ON c.id = w.channel_id`

type JoinedRow = OutgoingWebhookRow & {
  created_by_username: string | null
  channel_name: string | null
}

/** DB row → wire shape: JSON-decode `events`, and turn 0/1 columns into booleans. */
function mapWebhook(row: JoinedRow) {
  let events: string[] = []
  try {
    const parsed = JSON.parse(row.events)
    if (Array.isArray(parsed)) events = parsed.filter((e): e is string => typeof e === 'string')
  } catch {
    /* corrupt row — surface it as "no events" rather than failing the list */
  }

  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    events,
    format: row.format,
    enabled: row.enabled === 1,
    skip_webhook_messages: row.skip_webhook_messages === 1,
    created_by: row.created_by,
    created_by_username: row.created_by_username,
    created_at: row.created_at,
    last_delivery_at: row.last_delivery_at,
    last_status: row.last_status,
    last_error: row.last_error,
    consecutive_failures: row.consecutive_failures,
    disabled_reason: row.disabled_reason,
  }
}

function getWebhook(id: string) {
  return getDb().prepare(`${SELECT_WEBHOOK} WHERE w.id = ?`).get(id) as JoinedRow | undefined
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, MAX_NAME) : null
}

/**
 * Validates the event list. A channel-scoped webhook may only subscribe to
 * events that actually carry a channel — subscribing it to `member.joined`
 * would silently never fire, which is worse than an error.
 */
function normalizeEvents(
  value: unknown,
  channelId: string | null,
): { events: OutgoingWebhookEvent[] } | { error: string } {
  if (!Array.isArray(value)) return { error: 'events must be an array' }
  const events: OutgoingWebhookEvent[] = []
  for (const raw of value) {
    if (!isOutgoingWebhookEvent(raw)) return { error: `unknown event: ${String(raw)}` }
    if (channelId && !isChannelScopedEvent(raw)) {
      return {
        error: `"${raw}" is a server-wide event and cannot be used on a channel-scoped webhook`,
      }
    }
    if (!events.includes(raw)) events.push(raw)
  }
  if (events.length === 0) return { error: 'select at least one event' }
  return { events }
}

function normalizeChannelId(value: unknown): { channelId: string | null } | { error: string } {
  if (value === undefined || value === null || value === '') return { channelId: null }
  if (typeof value !== 'string') return { error: 'channel_id must be a string or null' }
  const channel = getDb().prepare('SELECT id, type FROM channels WHERE id = ?').get(value) as
    | { id: string; type: string }
    | undefined
  if (!channel) return { error: 'channel not found' }
  if (channel.type !== 'text')
    return { error: 'outgoing webhooks can only be scoped to text channels' }
  return { channelId: channel.id }
}

function normalizeUrl(value: unknown): { url: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: 'url required' }
  const url = value.trim()
  if (url.length > MAX_URL) return { error: `url too long (max ${MAX_URL})` }
  const safe = isSafeWebhookTarget(url)
  if (!safe.ok) return { error: safe.reason }
  return { url }
}

// GET /api/outgoing-webhooks — all of them, or one channel's with ?channel_id=
outgoingWebhookRoutes.get('/', authMiddleware, requirePermission('manage_webhooks'), (c) => {
  const channelId = c.req.query('channel_id')
  const rows = (
    channelId
      ? getDb()
          .prepare(`${SELECT_WEBHOOK} WHERE w.channel_id = ? ORDER BY w.created_at DESC`)
          .all(channelId)
      : getDb().prepare(`${SELECT_WEBHOOK} ORDER BY w.created_at DESC`).all()
  ) as JoinedRow[]
  return c.json({ webhooks: rows.map(mapWebhook) })
})

/** The catalogue the settings UI renders its event checkboxes from. */
outgoingWebhookRoutes.get('/events', authMiddleware, requirePermission('manage_webhooks'), (c) => {
  return c.json({ events: OUTGOING_WEBHOOK_EVENTS })
})

outgoingWebhookRoutes.post('/', authMiddleware, requirePermission('manage_webhooks'), async (c) => {
  const db = getDb()
  const { userId } = getAuth(c)
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'invalid JSON body' }, 400)

  const name = normalizeName(body.name)
  if (!name) return c.json({ error: `name required (1-${MAX_NAME} chars)` }, 400)

  const urlResult = normalizeUrl(body.url)
  if ('error' in urlResult) return c.json({ error: urlResult.error }, 400)

  const channelResult = normalizeChannelId(body.channel_id)
  if ('error' in channelResult) return c.json({ error: channelResult.error }, 400)

  const eventsResult = normalizeEvents(body.events, channelResult.channelId)
  if ('error' in eventsResult) return c.json({ error: eventsResult.error }, 400)

  const format =
    typeof body.format === 'string' && VALID_FORMATS.has(body.format) ? body.format : 'kizuna'

  const id = uuidv4()
  db.prepare(
    `INSERT INTO outgoing_webhooks (id, name, url, secret, channel_id, events, format, skip_webhook_messages, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    urlResult.url,
    generateWebhookSecret(),
    channelResult.channelId,
    JSON.stringify(eventsResult.events),
    format,
    body.skip_webhook_messages ? 1 : 0,
    userId,
  )
  logAuditEvent(
    db,
    'outgoing_webhook_created',
    userId,
    id,
    JSON.stringify({ name, url: urlResult.url, events: eventsResult.events }),
  )

  return c.json({ webhook: mapWebhook(getWebhook(id)!) }, 201)
})

outgoingWebhookRoutes.patch(
  '/:id',
  authMiddleware,
  requirePermission('manage_webhooks'),
  async (c) => {
    const db = getDb()
    const id = c.req.param('id')!
    const { userId } = getAuth(c)
    const existing = getWebhook(id)
    if (!existing) return c.json({ error: 'not found' }, 404)

    const body = await c.req.json().catch(() => null)
    if (!body) return c.json({ error: 'invalid JSON body' }, 400)

    const updates: string[] = []
    const values: unknown[] = []

    if (body.name !== undefined) {
      const name = normalizeName(body.name)
      if (!name) return c.json({ error: `name required (1-${MAX_NAME} chars)` }, 400)
      updates.push('name = ?')
      values.push(name)
    }

    if (body.url !== undefined) {
      const urlResult = normalizeUrl(body.url)
      if ('error' in urlResult) return c.json({ error: urlResult.error }, 400)
      updates.push('url = ?')
      values.push(urlResult.url)
    }

    // Scope and events interact: narrowing to a channel can invalidate an
    // existing server-wide subscription, so validate them together against
    // whichever scope the request ends up with.
    let scope: string | null = existing.channel_id
    if (body.channel_id !== undefined) {
      const channelResult = normalizeChannelId(body.channel_id)
      if ('error' in channelResult) return c.json({ error: channelResult.error }, 400)
      scope = channelResult.channelId
      updates.push('channel_id = ?')
      values.push(scope)
    }

    if (body.events !== undefined || body.channel_id !== undefined) {
      const raw = body.events !== undefined ? body.events : JSON.parse(existing.events)
      const eventsResult = normalizeEvents(raw, scope)
      if ('error' in eventsResult) return c.json({ error: eventsResult.error }, 400)
      updates.push('events = ?')
      values.push(JSON.stringify(eventsResult.events))
    }

    if (body.format !== undefined) {
      if (typeof body.format !== 'string' || !VALID_FORMATS.has(body.format)) {
        return c.json({ error: 'format must be kizuna, discord, or slack' }, 400)
      }
      updates.push('format = ?')
      values.push(body.format)
    }

    if (body.skip_webhook_messages !== undefined) {
      updates.push('skip_webhook_messages = ?')
      values.push(body.skip_webhook_messages ? 1 : 0)
    }

    if (body.enabled !== undefined) {
      const enabled = body.enabled ? 1 : 0
      updates.push('enabled = ?')
      values.push(enabled)
      // Re-enabling is the admin saying "I fixed it" — clear the auto-disable
      // state so the hook gets a full run of attempts again.
      if (enabled === 1) {
        updates.push('disabled_reason = NULL', 'consecutive_failures = 0')
      }
    }

    if (updates.length === 0) return c.json({ error: 'nothing to update' }, 400)

    values.push(id)
    db.prepare(`UPDATE outgoing_webhooks SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    logAuditEvent(
      db,
      'outgoing_webhook_updated',
      userId,
      id,
      JSON.stringify({ name: existing.name }),
    )

    return c.json({ webhook: mapWebhook(getWebhook(id)!) })
  },
)

outgoingWebhookRoutes.delete('/:id', authMiddleware, requirePermission('manage_webhooks'), (c) => {
  const db = getDb()
  const id = c.req.param('id')!
  const { userId } = getAuth(c)
  const existing = getWebhook(id)
  if (!existing) return c.json({ error: 'not found' }, 404)

  db.prepare('DELETE FROM outgoing_webhooks WHERE id = ?').run(id)
  logAuditEvent(
    db,
    'outgoing_webhook_deleted',
    userId,
    id,
    JSON.stringify({ name: existing.name, url: existing.url }),
  )
  return c.json({ ok: true })
})

// Rotating invalidates signatures for anything still using the old secret.
outgoingWebhookRoutes.post(
  '/:id/regenerate',
  authMiddleware,
  requirePermission('manage_webhooks'),
  (c) => {
    const db = getDb()
    const id = c.req.param('id')!
    const { userId } = getAuth(c)
    const existing = getWebhook(id)
    if (!existing) return c.json({ error: 'not found' }, 404)

    db.prepare('UPDATE outgoing_webhooks SET secret = ? WHERE id = ?').run(
      generateWebhookSecret(),
      id,
    )
    logAuditEvent(
      db,
      'outgoing_webhook_secret_regenerated',
      userId,
      id,
      JSON.stringify({ name: existing.name }),
    )

    return c.json({ webhook: mapWebhook(getWebhook(id)!) })
  },
)

// Synchronous single delivery so the UI can report what actually happened.
outgoingWebhookRoutes.post(
  '/:id/test',
  authMiddleware,
  requirePermission('manage_webhooks'),
  async (c) => {
    const db = getDb()
    const id = c.req.param('id')!
    const { userId } = getAuth(c)
    const existing = getWebhook(id)
    if (!existing) return c.json({ error: 'not found' }, 404)

    const result = await deliverOnce(id)
    logAuditEvent(
      db,
      'outgoing_webhook_tested',
      userId,
      id,
      JSON.stringify({ name: existing.name, status: result.status }),
    )

    return c.json({ result })
  },
)

outgoingWebhookRoutes.get(
  '/:id/deliveries',
  authMiddleware,
  requirePermission('manage_webhooks'),
  (c) => {
    const id = c.req.param('id')!
    if (!getWebhook(id)) return c.json({ error: 'not found' }, 404)

    const deliveries = getDb()
      .prepare(
        `SELECT id, webhook_id, event, status, error, duration_ms, attempt, created_at
       FROM outgoing_webhook_deliveries
       WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(id, DELIVERY_LIMIT)

    return c.json({ deliveries })
  },
)

export default outgoingWebhookRoutes
