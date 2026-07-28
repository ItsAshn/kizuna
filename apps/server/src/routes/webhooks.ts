import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware, isUserAdmin, canViewChannel, getUserChannelPermission } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import type { Context } from 'hono'
import { getAuth } from '../utils/auth'
import { emitToChannel } from '../utils/io'
import { dispatchOutgoing } from '../services/outgoingWebhooks'
import { logAuditEvent } from './audit'

const MAX_CONTENT = 4000
const MAX_NAME = 80
const MAX_AVATAR = 2048
// Per-token budget for the public endpoint. The global per-IP apiLimiter can't
// see webhooks (a single CI host may drive many of them), so a chatty
// integration would otherwise flood a channel unchecked.
const INCOMING_MAX_PER_MIN = 30

const webhooksRouter = new Hono()

interface WebhookRow {
  id: string
  channel_id: string
  name: string
  token: string
  avatar: string | null
  created_by: string
  created_at: number
  last_used_at: number | null
}

const SELECT_WEBHOOK = `
  SELECT w.id, w.channel_id, w.name, w.token, w.avatar, w.created_by, w.created_at, w.last_used_at,
         u.username AS created_by_username, c.name AS channel_name
  FROM webhooks w
  LEFT JOIN users u ON u.id = w.created_by
  LEFT JOIN channels c ON c.id = w.channel_id`

/**
 * Webhooks post as the server itself, so managing them is a channel-scoped
 * moderation action: admins always, plus anyone holding manage_webhooks
 * (honouring per-channel role overrides). Previously *any* authenticated user
 * could create one — and read every token — in any channel.
 *
 * This used to key off manage_channels; it moved to its own permission once
 * outgoing webhooks arrived, since piping channel content to a third party is a
 * meaningfully different grant from renaming a channel. Existing roles holding
 * manage_channels were back-filled by the roles_backfill_manage_webhooks
 * migration, so nobody silently lost access.
 */
function canManageWebhooks(userId: string, channelId: string): boolean {
  if (isUserAdmin(userId)) return true
  if (!canViewChannel(userId, channelId)) return false
  return getUserChannelPermission(userId, channelId, 'manage_webhooks')
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  return trimmed.slice(0, MAX_NAME)
}

// Avatars end up in an <img src> on every client, so only allow schemes that
// can't execute (no javascript:, no arbitrary data: payloads).
function normalizeAvatar(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_AVATAR) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) return trimmed
  return null
}

function getWebhookById(id: string): WebhookRow | undefined {
  return getDb().prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined
}

webhooksRouter.post('/channels/:channelId/webhooks', authMiddleware, async (c) => {
  const db = getDb()
  const channelId = c.req.param('channelId')!
  const { userId } = getAuth(c)

  const channel = db.prepare('SELECT id, type FROM channels WHERE id = ?').get(channelId) as { id: string; type: string } | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  if (channel.type !== 'text') return c.json({ error: 'Webhooks are only supported in text channels' }, 400)
  if (!canManageWebhooks(userId, channelId)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json().catch(() => null)
  const name = normalizeName(body?.name)
  if (!name) return c.json({ error: `name required (1-${MAX_NAME} chars)` }, 400)
  const avatar = body?.avatar !== undefined ? normalizeAvatar(body.avatar) : null

  const id = uuidv4()
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO webhooks (id, channel_id, name, token, avatar, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, channelId, name, token, avatar, userId)
  logAuditEvent(db, 'webhook_created', userId, id, JSON.stringify({ name, channelId }))

  const webhook = db.prepare(`${SELECT_WEBHOOK} WHERE w.id = ?`).get(id)
  return c.json({ webhook }, 201)
})

webhooksRouter.get('/channels/:channelId/webhooks', authMiddleware, async (c) => {
  const db = getDb()
  const channelId = c.req.param('channelId')!
  const { userId } = getAuth(c)
  if (!canManageWebhooks(userId, channelId)) return c.json({ error: 'Forbidden' }, 403)

  const webhooks = db.prepare(`${SELECT_WEBHOOK} WHERE w.channel_id = ? ORDER BY w.created_at DESC`).all(channelId)
  return c.json({ webhooks })
})

// Server-wide list — lets the settings UI show every webhook at once instead of
// only those belonging to whichever channel the create form happens to target.
webhooksRouter.get('/webhooks', authMiddleware, async (c) => {
  const db = getDb()
  const { userId } = getAuth(c)
  const rows = db.prepare(`${SELECT_WEBHOOK} ORDER BY w.created_at DESC`).all() as (WebhookRow & { channel_name: string | null })[]
  const webhooks = rows.filter((w) => canManageWebhooks(userId, w.channel_id))
  return c.json({ webhooks })
})

webhooksRouter.delete('/webhooks/:webhookId', authMiddleware, async (c) => {
  const db = getDb()
  const webhookId = c.req.param('webhookId')!
  const { userId } = getAuth(c)
  const webhook = getWebhookById(webhookId)
  if (!webhook) return c.json({ error: 'not found' }, 404)
  if (!canManageWebhooks(userId, webhook.channel_id)) return c.json({ error: 'Forbidden' }, 403)

  db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId)
  logAuditEvent(db, 'webhook_deleted', userId, webhookId, JSON.stringify({ name: webhook.name, channelId: webhook.channel_id }))
  return c.json({ ok: true })
})

webhooksRouter.patch('/webhooks/:webhookId', authMiddleware, async (c) => {
  const db = getDb()
  const webhookId = c.req.param('webhookId')!
  const { userId } = getAuth(c)
  const webhook = getWebhookById(webhookId)
  if (!webhook) return c.json({ error: 'not found' }, 404)
  if (!canManageWebhooks(userId, webhook.channel_id)) return c.json({ error: 'Forbidden' }, 403)

  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'invalid JSON body' }, 400)

  const hasName = body.name !== undefined
  const hasAvatar = body.avatar !== undefined
  if (!hasName && !hasAvatar) return c.json({ error: 'name or avatar required' }, 400)

  if (hasName) {
    const name = normalizeName(body.name)
    if (!name) return c.json({ error: `name required (1-${MAX_NAME} chars)` }, 400)
    db.prepare('UPDATE webhooks SET name = ? WHERE id = ?').run(name, webhookId)
  }
  if (hasAvatar) {
    // Explicit null/empty clears the avatar; anything unusable is rejected
    // rather than silently dropped so the UI can show why.
    const cleared = body.avatar === null || body.avatar === ''
    const avatar = cleared ? null : normalizeAvatar(body.avatar)
    if (!cleared && !avatar) return c.json({ error: 'avatar must be an http(s) or data:image URL' }, 400)
    db.prepare('UPDATE webhooks SET avatar = ? WHERE id = ?').run(avatar, webhookId)
  }
  logAuditEvent(db, 'webhook_updated', userId, webhookId, JSON.stringify({ name: normalizeName(body.name) ?? webhook.name }))

  const updated = db.prepare(`${SELECT_WEBHOOK} WHERE w.id = ?`).get(webhookId)
  return c.json({ webhook: updated })
})

// Rotating the token is the only way to revoke a leaked URL without losing the
// webhook's identity and history.
webhooksRouter.post('/webhooks/:webhookId/regenerate', authMiddleware, async (c) => {
  const db = getDb()
  const webhookId = c.req.param('webhookId')!
  const { userId } = getAuth(c)
  const webhook = getWebhookById(webhookId)
  if (!webhook) return c.json({ error: 'not found' }, 404)
  if (!canManageWebhooks(userId, webhook.channel_id)) return c.json({ error: 'Forbidden' }, 403)

  const token = crypto.randomBytes(32).toString('hex')
  db.prepare('UPDATE webhooks SET token = ? WHERE id = ?').run(token, webhookId)
  logAuditEvent(db, 'webhook_token_regenerated', userId, webhookId, JSON.stringify({ name: webhook.name }))

  const updated = db.prepare(`${SELECT_WEBHOOK} WHERE w.id = ?`).get(webhookId)
  return c.json({ webhook: updated })
})

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function repoName(body: Record<string, unknown>): string {
  return asString(asRecord(body.repository)?.full_name) ?? 'repository'
}

/** First line of a commit/PR body, kept short enough to stay readable in chat. */
function firstLine(text: unknown, max = 100): string {
  const str = asString(text) ?? ''
  return truncate(str.split('\n')[0] ?? '', max)
}

type Formatted = { content: string } | { skip: string } | undefined

function formatGitHubEvent(event: string, body: Record<string, unknown>): Formatted {
  // GitHub fires `ping` the moment a hook is saved. Answering 2xx without
  // posting is what marks the integration "green" in GitHub's UI.
  if (event === 'ping') return { skip: 'ping' }

  const repo = repoName(body)
  const action = asString(body.action)

  if (event === 'push') {
    const branch = asString(body.ref)?.replace('refs/heads/', '') ?? 'unknown'
    const commits = Array.isArray(body.commits) ? (body.commits as Record<string, unknown>[]) : []
    // Branch deletions and tag pushes arrive with no commits — not worth a message.
    if (commits.length === 0) return { skip: 'push without commits' }
    let msg = `🔨 **${repo}**: ${commits.length} commit${commits.length === 1 ? '' : 's'} pushed to \`${branch}\``
    msg += '\n' + commits.slice(0, 5).map((commit) => {
      const sha = asString(commit.id)?.slice(0, 7) ?? '???????'
      return `- \`${sha}\` ${firstLine(commit.message)}`
    }).join('\n')
    if (commits.length > 5) msg += `\n...and ${commits.length - 5} more`
    const compare = asString(body.compare)
    if (compare) msg += `\n${compare}`
    return { content: msg }
  }

  if (event === 'release') {
    const release = asRecord(body.release)
    const tag = asString(release?.tag_name) ?? asString(release?.name) ?? 'unknown'
    const prerelease = release?.prerelease ? ' (pre-release)' : ''
    const url = asString(release?.html_url) ?? ''
    return { content: `${action === 'published' ? '🚀' : '📦'} **${repo}**: Release ${tag}${prerelease}\n${url}`.trim() }
  }

  if (event === 'issues') {
    const issue = asRecord(body.issue)
    return { content: `📝 **${repo}**: Issue ${action ?? 'updated'}: ${firstLine(issue?.title)}\n${asString(issue?.html_url) ?? ''}`.trim() }
  }

  if (event === 'issue_comment' && action === 'created') {
    const issue = asRecord(body.issue)
    const comment = asRecord(body.comment)
    const who = asString(asRecord(body.sender)?.login) ?? 'someone'
    return { content: `💬 **${repo}**: ${who} commented on ${firstLine(issue?.title)}\n${asString(comment?.html_url) ?? ''}`.trim() }
  }

  if (event === 'pull_request') {
    const pr = asRecord(body.pull_request)
    // "closed + merged" is the interesting half of the noisiest PR action.
    const verb = action === 'closed' && pr?.merged ? 'merged' : action ?? 'updated'
    const icon = verb === 'merged' ? '✅' : '🔀'
    return { content: `${icon} **${repo}**: PR ${verb}: ${firstLine(pr?.title)}\n${asString(pr?.html_url) ?? ''}`.trim() }
  }

  if (event === 'star' && action === 'created') {
    const who = asString(asRecord(body.sender)?.login) ?? 'someone'
    return { content: `⭐ **${repo}**: Starred by ${who}` }
  }

  if (event === 'fork') {
    const fork = asString(asRecord(body.forkee)?.full_name) ?? 'a fork'
    return { content: `🍴 **${repo}**: Forked to ${fork}` }
  }

  if (event === 'workflow_run' && action === 'completed') {
    const run = asRecord(body.workflow_run)
    const conclusion = asString(run?.conclusion) ?? 'finished'
    const icon = conclusion === 'success' ? '✅' : conclusion === 'failure' ? '❌' : '⚠️'
    return { content: `${icon} **${repo}**: ${asString(run?.name) ?? 'Workflow'} ${conclusion} on \`${asString(run?.head_branch) ?? '?'}\`\n${asString(run?.html_url) ?? ''}`.trim() }
  }

  return { skip: `unhandled github event: ${event}` }
}

/** Discord-style embeds → readable markdown, so Discord-targeted senders work. */
function formatEmbeds(embeds: unknown): string | undefined {
  if (!Array.isArray(embeds) || embeds.length === 0) return undefined
  const parts: string[] = []
  for (const raw of embeds.slice(0, 5)) {
    const embed = asRecord(raw)
    if (!embed) continue
    const lines: string[] = []
    const title = asString(embed.title)
    const url = asString(embed.url)
    if (title) lines.push(url ? `**[${title}](${url})**` : `**${title}**`)
    const author = asString(asRecord(embed.author)?.name)
    if (author && !title) lines.push(`**${author}**`)
    const description = asString(embed.description)
    if (description) lines.push(description)
    const fields = Array.isArray(embed.fields) ? embed.fields : []
    for (const rawField of fields.slice(0, 10)) {
      const field = asRecord(rawField)
      const name = asString(field?.name)
      const value = asString(field?.value)
      if (name && value) lines.push(`**${name}**: ${value}`)
    }
    const footer = asString(asRecord(embed.footer)?.text)
    if (footer) lines.push(`_${footer}_`)
    if (lines.length) parts.push(lines.join('\n'))
  }
  return parts.length ? parts.join('\n\n') : undefined
}

/** Slack-style `attachments` fallback (`text`/`pretext`/`fallback`). */
function formatSlackAttachments(attachments: unknown): string | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined
  const parts: string[] = []
  for (const raw of attachments.slice(0, 5)) {
    const att = asRecord(raw)
    if (!att) continue
    const text = asString(att.text) ?? asString(att.fallback) ?? asString(att.pretext)
    const title = asString(att.title)
    if (title && text) parts.push(`**${title}**\n${text}`)
    else if (title || text) parts.push((title ?? text)!)
  }
  return parts.length ? parts.join('\n\n') : undefined
}

/**
 * Resolves a payload into message content. Returning `{ skip }` means "valid
 * request, nothing worth posting" — senders get a 2xx so their delivery log
 * stays green instead of retrying forever.
 */
function resolveContent(c: Context, body: Record<string, unknown>): Formatted {
  const direct = asString(body.content) ?? asString(body.text) ?? asString(body.message)
  if (direct) return { content: direct }

  const ghEvent = c.req.header('X-GitHub-Event')
  if (ghEvent) return formatGitHubEvent(ghEvent, body)

  const embeds = formatEmbeds(body.embeds)
  if (embeds) return { content: embeds }

  const slack = formatSlackAttachments(body.attachments)
  if (slack) return { content: slack }

  return undefined
}

const incomingHits = new Map<string, { count: number; resetAt: number }>()

function overIncomingLimit(token: string): boolean {
  const now = Date.now()
  const entry = incomingHits.get(token)
  if (!entry || entry.resetAt <= now) {
    incomingHits.set(token, { count: 1, resetAt: now + 60_000 })
    if (incomingHits.size > 5_000) {
      for (const [key, value] of incomingHits) if (value.resetAt <= now) incomingHits.delete(key)
    }
    return false
  }
  if (entry.count >= INCOMING_MAX_PER_MIN) return true
  entry.count++
  return false
}

/** Accepts JSON, plus the `payload=<json>` form encoding GitHub can be set to. */
async function parseIncomingBody(c: Context): Promise<Record<string, unknown> | null> {
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.parseBody().catch(() => null)
    const payload = form && typeof form.payload === 'string' ? form.payload : null
    if (!payload) return null
    try { return JSON.parse(payload) as Record<string, unknown> } catch { return null }
  }
  const json = await c.req.json().catch(() => null)
  return asRecord(json) ?? null
}

// Public incoming webhook endpoint (no auth — validated by token)
webhooksRouter.post('/webhooks/incoming/:token', async (c) => {
  const db = getDb()
  const token = c.req.param('token')!
  const webhook = db.prepare('SELECT * FROM webhooks WHERE token = ?').get(token) as WebhookRow | undefined
  if (!webhook) return c.json({ error: 'invalid token' }, 401)

  if (overIncomingLimit(token)) {
    c.header('Retry-After', '60')
    return c.json({ error: `rate limited (max ${INCOMING_MAX_PER_MIN} messages/min per webhook)` }, 429)
  }

  const body = await parseIncomingBody(c)
  if (!body) return c.json({ error: 'invalid JSON body' }, 400)

  let resolved: Formatted
  try {
    resolved = resolveContent(c, body)
  } catch (err: unknown) {
    console.error('[webhook] format error:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Failed to parse webhook payload' }, 400)
  }

  if (!resolved) {
    return c.json({ error: 'no content — send { "content": "..." } or a supported payload' }, 400)
  }
  if ('skip' in resolved) {
    // 202: understood and accepted, deliberately not posted.
    return c.json({ ok: true, skipped: resolved.skip }, 202)
  }

  const content = truncate(resolved.content, MAX_CONTENT)
  const displayName = normalizeName(body.username) ?? webhook.name
  const avatar = normalizeAvatar(body.avatar_url) ?? webhook.avatar ?? null

  const messageId = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  try {
    db.prepare(`INSERT INTO messages (id, channel_id, author_id, content, author_username, author_display_name, author_avatar, webhook_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId, webhook.channel_id, '', content,
      webhook.name, displayName, avatar, webhook.id, now
    )
    db.prepare('UPDATE webhooks SET last_used_at = ? WHERE id = ?').run(now, webhook.id)
  } catch (err: unknown) {
    console.error('[webhook] db insert error:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Failed to create message' }, 500)
  }

  const message = {
    id: messageId,
    channel_id: webhook.channel_id,
    user_id: null,
    webhook_id: webhook.id,
    content,
    username: webhook.name,
    display_name: displayName,
    avatar,
    created_at: now * 1000,
    edited_at: null, reply_to_message_id: null, reply_to_username: null, reply_to_content: null,
    reactions: [],
  }

  // Fan out like a normal message: the channel room *and* every eligible
  // member's personal room, so people who aren't looking at the channel still
  // get an unread badge and a notification. The empty actor id excludes nobody.
  emitToChannel(c, webhook.channel_id, 'message:new', message, '')
  // viaWebhook lets outgoing hooks opt out of re-broadcasting bridged-in
  // messages, which is how two bridged servers avoid echoing at each other.
  dispatchOutgoing('message.created', {
    channel: { id: webhook.channel_id },
    user: { username: displayName },
    message: { id: messageId, content, webhook_id: webhook.id },
  }, { channelId: webhook.channel_id, viaWebhook: true })

  return c.json({ ok: true, messageId })
})

export default webhooksRouter
