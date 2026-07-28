import { createHmac, randomBytes } from 'crypto'
import { v4 as uuidv4 } from 'uuid'
// Imported via the subpath rather than the package root: the root barrel pulls
// in axios and tweetnacl (client-only), whereas webhook-events is pure
// functions over pure types. Client and server must agree on event names and
// the signature scheme, so this stays one shared source of truth.
import {
  WEBHOOK_SIGNATURE_PREFIX,
  isChannelScopedEvent,
  renderEventText,
  webhookSignatureBase,
  type OutgoingWebhookEvent,
  type OutgoingWebhookEventData,
} from '@kizuna/shared/webhook-events'
import { getDb } from '../db'
import { createLogger } from '../utils/logger'

const log = createLogger('outgoing-webhooks')

export interface OutgoingWebhookConfig {
  timeoutMs: number
  maxAttempts: number
  concurrency: number
  ratePerMin: number
  allowPrivateTargets: boolean
  serverName: string
  serverUrl: string
}

const config: OutgoingWebhookConfig = {
  timeoutMs: 10_000,
  maxAttempts: 4,
  concurrency: 4,
  ratePerMin: 60,
  allowPrivateTargets: false,
  serverName: 'Kizuna Server',
  serverUrl: '',
}

export function configureOutgoingWebhooks(partial: Partial<OutgoingWebhookConfig>): void {
  Object.assign(config, partial)
}

/**
 * Backoff between attempts. Index 0 is the first (immediate) try, so a job on
 * attempt N waits RETRY_DELAYS_MS[N] before the next one. Capped by
 * `maxAttempts`; a shorter schedule than the configured attempt count simply
 * reuses the last delay.
 */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000]

/** Beyond this the endpoint is presumed dead and the hook is auto-disabled. */
const MAX_CONSECUTIVE_FAILURES = 20

/** Bounds memory if a target hangs and the queue backs up. */
const MAX_QUEUE = 500

/** Delivery rows retained per webhook. */
const DELIVERY_LOG_LIMIT = 20

export interface OutgoingWebhookRow {
  id: string
  name: string
  url: string
  secret: string
  channel_id: string | null
  events: string
  format: string
  enabled: number
  skip_webhook_messages: number
  created_by: string | null
  created_at: number
  last_delivery_at: number | null
  last_status: number | null
  last_error: string | null
  consecutive_failures: number
  disabled_reason: string | null
}

interface Job {
  deliveryId: string
  webhookId: string
  event: OutgoingWebhookEvent | 'ping'
  body: string
  attempt: number
  nextAt: number
}

const queue: Job[] = []
let inFlight = 0
let timer: NodeJS.Timeout | null = null

// ---------------------------------------------------------------------------
// Target validation (SSRF)
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
])

/** Literal IPv4 in any of the private / loopback / link-local ranges. */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN))
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false
  const [a, b] = nums as [number, number, number, number]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 169.254/16 covers cloud metadata (169.254.169.254) as well as APIPA.
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fe80:')) return true // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // unique-local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1) inherits the v4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) return isPrivateIPv4(mapped[1]!)
  return false
}

/**
 * Rejects targets that would let a webhook reach services on the host network,
 * plus this server's own incoming-webhook endpoint (which would loop forever).
 *
 * This is a literal-address and hostname check, not a DNS-rebinding-proof one:
 * a hostname that resolves to a private address at request time still gets
 * through. Resolving and pinning the address would be disproportionate here —
 * the URL is set by someone already holding manage_webhooks, and the goal is to
 * stop accidents and casual probing rather than a determined admin.
 */
export function isSafeWebhookTarget(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'not a valid URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'url must be http or https' }
  }

  // A hook pointed at our own incoming endpoint would post a message, which
  // fires message.created, which posts another message, forever.
  if (url.pathname.includes('/api/webhooks/incoming/')) {
    return { ok: false, reason: 'cannot target an incoming webhook endpoint — that would loop' }
  }

  if (config.allowPrivateTargets) return { ok: true }

  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return {
      ok: false,
      reason: `"${host}" is a local address — set ALLOW_PRIVATE_WEBHOOK_TARGETS=true to allow it`,
    }
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return {
      ok: false,
      reason: `"${host}" is a private address — set ALLOW_PRIVATE_WEBHOOK_TARGETS=true to allow it`,
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

function parseEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

function buildBody(
  webhook: OutgoingWebhookRow,
  event: OutgoingWebhookEvent | 'ping',
  data: OutgoingWebhookEventData,
  deliveryId: string,
  timestamp: number,
): string {
  if (webhook.format === 'discord') {
    return JSON.stringify({
      content: renderEventText(event, data),
      username: webhook.name,
    })
  }
  if (webhook.format === 'slack') {
    return JSON.stringify({ text: renderEventText(event, data) })
  }
  return JSON.stringify({
    event,
    delivery_id: deliveryId,
    timestamp,
    server: { name: config.serverName, url: config.serverUrl },
    data,
  })
}

function signBody(secret: string, timestamp: number, body: string): string {
  return (
    WEBHOOK_SIGNATURE_PREFIX +
    createHmac('sha256', secret).update(webhookSignatureBase(timestamp, body)).digest('hex')
  )
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const rateHits = new Map<string, { count: number; resetAt: number }>()

function overRateLimit(webhookId: string): boolean {
  const now = Date.now()
  const entry = rateHits.get(webhookId)
  if (!entry || entry.resetAt <= now) {
    rateHits.set(webhookId, { count: 1, resetAt: now + 60_000 })
    return false
  }
  if (entry.count >= config.ratePerMin) return true
  entry.count++
  return false
}

let lastQueueWarnAt = 0

/**
 * Fire-and-forget entry point, called from route and socket handlers alike.
 * Deliberately synchronous, context-free, and non-throwing: a webhook problem
 * must never fail or slow down the action that triggered it.
 *
 * `channelId` scopes the event to a channel; `viaWebhook` marks messages that
 * arrived through an incoming webhook so bridging setups can skip them.
 */
export function dispatchOutgoing(
  event: OutgoingWebhookEvent,
  data: OutgoingWebhookEventData,
  opts?: { channelId?: string; viaWebhook?: boolean },
): void {
  try {
    const rows = getDb()
      .prepare('SELECT * FROM outgoing_webhooks WHERE enabled = 1')
      .all() as OutgoingWebhookRow[]
    if (rows.length === 0) return

    const channelId = opts?.channelId
    const now = Date.now()

    // Call sites generally have only a channel id. Resolving the name costs a
    // query, so do it at most once and only after something has matched — the
    // common case is a server with no outgoing webhooks configured at all.
    let payload = data
    let resolvedChannel = false
    const withChannelName = (): OutgoingWebhookEventData => {
      if (resolvedChannel || !channelId || data.channel?.name) return payload
      resolvedChannel = true
      const row = getDb().prepare('SELECT name FROM channels WHERE id = ?').get(channelId) as
        | { name: string }
        | undefined
      payload = { ...data, channel: { id: channelId, name: row?.name ?? null } }
      return payload
    }

    for (const webhook of rows) {
      if (!parseEvents(webhook.events).includes(event)) continue

      if (webhook.channel_id) {
        // A channel-scoped hook only ever sees its own channel's events, and
        // only events that are channel-scoped in the first place.
        if (!isChannelScopedEvent(event)) continue
        if (webhook.channel_id !== channelId) continue
      }

      if (opts?.viaWebhook && webhook.skip_webhook_messages) continue

      if (overRateLimit(webhook.id)) continue

      const deliveryId = uuidv4()
      const timestamp = Math.floor(now / 1000)
      enqueue({
        deliveryId,
        webhookId: webhook.id,
        event,
        body: buildBody(webhook, event, withChannelName(), deliveryId, timestamp),
        attempt: 0,
        nextAt: now,
      })
    }
  } catch (err) {
    log.warn(`dispatch failed for ${event}:`, err instanceof Error ? err.message : err)
  }
}

function enqueue(job: Job): void {
  if (queue.length >= MAX_QUEUE) {
    queue.shift()
    const now = Date.now()
    if (now - lastQueueWarnAt > 60_000) {
      lastQueueWarnAt = now
      log.warn(
        `delivery queue full (${MAX_QUEUE}) — dropping oldest events. Is a target endpoint hanging?`,
      )
    }
  }
  queue.push(job)
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

interface Attempt {
  status: number | null
  duration_ms: number
  error: string | null
}

/** Whether a failed attempt is worth retrying. Permanent 4xx are not. */
function isRetryable(status: number | null): boolean {
  if (status === null) return true // network error or timeout
  if (status === 408 || status === 429) return true
  return status >= 500
}

async function sendOnce(
  webhook: OutgoingWebhookRow,
  event: string,
  body: string,
  deliveryId: string,
): Promise<Attempt> {
  const safe = isSafeWebhookTarget(webhook.url)
  if (!safe.ok) return { status: null, duration_ms: 0, error: `blocked target: ${safe.reason}` }

  const timestamp = Math.floor(Date.now() / 1000)
  const started = Date.now()
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Kizuna-Webhook/1.0',
        'X-Kizuna-Event': event,
        'X-Kizuna-Delivery': deliveryId,
        'X-Kizuna-Timestamp': String(timestamp),
        'X-Kizuna-Signature': signBody(webhook.secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    // Drain the body so the socket can be reused rather than left half-read.
    await res.text().catch(() => '')
    return {
      status: res.status,
      duration_ms: Date.now() - started,
      error: res.ok ? null : `HTTP ${res.status}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: null,
      duration_ms: Date.now() - started,
      error:
        message.includes('timed out') || message.includes('aborted')
          ? 'request timed out'
          : message,
    }
  }
}

function recordAttempt(
  webhookId: string,
  deliveryId: string,
  event: string,
  attempt: number,
  result: Attempt,
): void {
  try {
    const db = getDb()
    db.prepare(
      `INSERT INTO outgoing_webhook_deliveries (id, webhook_id, event, status, error, duration_ms, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      webhookId,
      event,
      result.status,
      result.error?.slice(0, 500) ?? null,
      result.duration_ms,
      attempt,
    )

    // Keep the log to the most recent N per hook — it exists for the UI's
    // "recent deliveries" panel, not as an archive.
    db.prepare(
      `DELETE FROM outgoing_webhook_deliveries
       WHERE webhook_id = ? AND id NOT IN (
         SELECT id FROM outgoing_webhook_deliveries
         WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    ).run(webhookId, webhookId, DELIVERY_LOG_LIMIT)
  } catch (err) {
    log.warn(`could not record delivery ${deliveryId}:`, err instanceof Error ? err.message : err)
  }
}

function recordOutcome(webhookId: string, result: Attempt, succeeded: boolean): void {
  try {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    if (succeeded) {
      db.prepare(
        `UPDATE outgoing_webhooks
         SET last_delivery_at = ?, last_status = ?, last_error = NULL, consecutive_failures = 0
         WHERE id = ?`,
      ).run(now, result.status, webhookId)
      return
    }

    db.prepare(
      `UPDATE outgoing_webhooks
       SET last_delivery_at = ?, last_status = ?, last_error = ?, consecutive_failures = consecutive_failures + 1
       WHERE id = ?`,
    ).run(now, result.status, result.error?.slice(0, 500) ?? null, webhookId)

    const row = db
      .prepare('SELECT name, consecutive_failures FROM outgoing_webhooks WHERE id = ?')
      .get(webhookId) as { name: string; consecutive_failures: number } | undefined

    if (row && row.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
      const reason = `auto-disabled after ${row.consecutive_failures} consecutive failures`
      db.prepare('UPDATE outgoing_webhooks SET enabled = 0, disabled_reason = ? WHERE id = ?').run(
        reason,
        webhookId,
      )
      log.warn(`"${row.name}" ${reason}`)
    }
  } catch (err) {
    log.warn(`could not record outcome for ${webhookId}:`, err instanceof Error ? err.message : err)
  }
}

function getWebhook(id: string): OutgoingWebhookRow | undefined {
  return getDb().prepare('SELECT * FROM outgoing_webhooks WHERE id = ?').get(id) as
    | OutgoingWebhookRow
    | undefined
}

async function runJob(job: Job): Promise<void> {
  const webhook = getWebhook(job.webhookId)
  // Deleted or disabled while queued — drop it rather than deliver stale events.
  if (!webhook || !webhook.enabled) return

  const attemptNumber = job.attempt + 1
  const result = await sendOnce(webhook, job.event, job.body, job.deliveryId)
  const succeeded = result.status !== null && result.status >= 200 && result.status < 300

  recordAttempt(job.webhookId, job.deliveryId, job.event, attemptNumber, result)

  if (succeeded) {
    recordOutcome(job.webhookId, result, true)
    return
  }

  const canRetry = attemptNumber < config.maxAttempts && isRetryable(result.status)
  if (canRetry) {
    const delay = RETRY_DELAYS_MS[Math.min(attemptNumber, RETRY_DELAYS_MS.length - 1)]!
    enqueue({ ...job, attempt: attemptNumber, nextAt: Date.now() + delay })
    return
  }

  recordOutcome(job.webhookId, result, false)
  log.warn(
    `"${webhook.name}" delivery ${job.deliveryId} failed after ${attemptNumber} attempt(s): ${result.error}`,
  )
}

function tick(): void {
  if (queue.length === 0) return
  const now = Date.now()

  while (inFlight < config.concurrency) {
    const index = queue.findIndex((job) => job.nextAt <= now)
    if (index === -1) break
    const [job] = queue.splice(index, 1)
    if (!job) break

    inFlight++
    runJob(job)
      .catch((err) => log.warn('delivery crashed:', err instanceof Error ? err.message : err))
      .finally(() => {
        inFlight--
      })
  }
}

/**
 * One awaited delivery, used by the "send test" button so the UI can show a
 * real status and latency. Bypasses the queue and does not retry — the point is
 * to report exactly what the endpoint did right now.
 */
export async function deliverOnce(webhookId: string): Promise<Attempt> {
  const webhook = getWebhook(webhookId)
  if (!webhook) return { status: null, duration_ms: 0, error: 'webhook not found' }

  const deliveryId = uuidv4()
  const timestamp = Math.floor(Date.now() / 1000)
  const data: OutgoingWebhookEventData = {}
  const body = buildBody(webhook, 'ping', data, deliveryId, timestamp)

  const result = await sendOnce(webhook, 'ping', body, deliveryId)
  const succeeded = result.status !== null && result.status >= 200 && result.status < 300

  recordAttempt(webhookId, deliveryId, 'ping', 1, result)
  recordOutcome(webhookId, result, succeeded)
  return result
}

export function startOutgoingWebhooks(): void {
  if (timer) return
  timer = setInterval(tick, 1_000)
  timer.unref()

  // Rate-limit buckets are per-webhook and tiny, but a server that churns
  // through webhooks shouldn't leak entries forever.
  const gc = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of rateHits) if (entry.resetAt <= now) rateHits.delete(id)
  }, 60_000)
  gc.unref()
}
