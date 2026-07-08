import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import type { Context } from 'hono'
import { getAuth } from '../utils/auth'
import { emitToRoom } from '../utils/io'

const webhooksRouter = new Hono()

webhooksRouter.post('/channels/:channelId/webhooks', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param()
  const { userId } = getAuth(c)
  const body = await c.req.json().catch(() => null)
  const name = body?.name?.trim()
  if (!name) return c.json({ error: 'name required' }, 400)

  const id = uuidv4()
  const token = crypto.randomBytes(32).toString('hex')
  db.prepare('INSERT INTO webhooks (id, channel_id, name, token, created_by) VALUES (?, ?, ?, ?, ?)').run(id, channelId, name, token, userId)

  return c.json({ webhook: { id, channelId, name, token } })
})

webhooksRouter.get('/channels/:channelId/webhooks', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param()
  const rows = db.prepare('SELECT id, name, token, channel_id, created_at FROM webhooks WHERE channel_id = ?').all(channelId)
  return c.json({ webhooks: rows })
})

webhooksRouter.delete('/webhooks/:webhookId', authMiddleware, async (c) => {
  const db = getDb()
  const { webhookId } = c.req.param()
  const { userId } = getAuth(c)
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as { created_by: string } | undefined
  if (!webhook) return c.json({ error: 'not found' }, 404)
  if (webhook.created_by !== userId) {
    const admin = db.prepare('SELECT role FROM members WHERE user_id = ? AND role = ?').get(userId, 'admin')
    if (!admin) return c.json({ error: 'forbidden' }, 403)
  }
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId)
  return c.json({ ok: true })
})

webhooksRouter.patch('/webhooks/:webhookId', authMiddleware, async (c) => {
  const db = getDb()
  const { webhookId } = c.req.param()
  const { userId } = getAuth(c)
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as { created_by: string; name: string; avatar: string | null } | undefined
  if (!webhook) return c.json({ error: 'not found' }, 404)
  if (webhook.created_by !== userId) {
    const admin = db.prepare('SELECT role FROM members WHERE user_id = ? AND role = ?').get(userId, 'admin')
    if (!admin) return c.json({ error: 'forbidden' }, 403)
  }
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'invalid JSON body' }, 400)
  const name: string | undefined = typeof body.name === 'string' ? body.name.trim() : undefined
  const avatar: string | null | undefined = body.avatar !== undefined
    ? (typeof body.avatar === 'string' ? body.avatar.trim() || null : null)
    : undefined
  if (name === '' || (name === undefined && avatar === undefined)) return c.json({ error: 'name or avatar required' }, 400)
  if (name !== undefined) db.prepare('UPDATE webhooks SET name = ? WHERE id = ?').run(name, webhookId)
  if (avatar !== undefined) db.prepare('UPDATE webhooks SET avatar = ? WHERE id = ?').run(avatar, webhookId)
  const updated = db.prepare('SELECT id, name, avatar, token, channel_id, created_at FROM webhooks WHERE id = ?').get(webhookId)
  return c.json({ webhook: updated })
})

function formatWebhookContent(c: Context, body: Record<string, unknown>): string | undefined {
  const ghEvent = c.req.header('X-GitHub-Event')
  if (ghEvent === 'release') {
    const action = body.action
    const repo = (body.repository as Record<string, unknown> | undefined)?.full_name ?? 'unknown'
    const release = body.release as Record<string, unknown> | undefined
    const tag = release?.tag_name ?? release?.name ?? 'unknown'
    const url = release?.html_url ?? ''
    const prerelease = release?.prerelease ? ' (pre-release)' : ''
    return `${action === 'published' ? '🚀' : '📦'} **${repo}**: Release ${tag}${prerelease}\n${url}`
  }
  if (ghEvent === 'push') {
    const repo = (body.repository as Record<string, unknown> | undefined)?.full_name ?? 'unknown'
    const ref = (body as Record<string, unknown>).ref as string | undefined
    const branch = ref?.replace('refs/heads/', '') ?? 'unknown'
    const commits = (body as Record<string, unknown>).commits as Array<Record<string, unknown>> | undefined
    const compare = (body as Record<string, unknown>).compare as string | undefined
    let msg = `🔨 **${repo}**: ${commits?.length ?? 0} commit(s) pushed to \`${branch}\``
    if (commits?.length) {
      msg += '\n' + commits.slice(0, 5).map(c =>
        `- \`${(c.id as string).slice(0, 7)}\` ${c.message}`
      ).join('\n')
      if (commits.length > 5) msg += `\n...and ${commits.length - 5} more`
    }
    if (compare) msg += `\n${compare}`
    return msg
  }
  if (ghEvent === 'issues') {
    const repo = (body.repository as Record<string, unknown> | undefined)?.full_name ?? 'unknown'
    const issue = body.issue as Record<string, unknown> | undefined
    const title = issue?.title ?? 'unknown'
    const url = issue?.html_url ?? ''
    const action = body.action
    return `📝 **${repo}**: Issue ${action}: ${title}\n${url}`
  }
  if (ghEvent === 'pull_request') {
    const repo = (body.repository as Record<string, unknown> | undefined)?.full_name ?? 'unknown'
    const pr = body.pull_request as Record<string, unknown> | undefined
    const title = pr?.title ?? 'unknown'
    const url = pr?.html_url ?? ''
    const action = body.action
    const merged = pr?.merged ? ' (merged)' : ''
    return `🔀 **${repo}**: PR ${action}${merged}: ${title}\n${url}`
  }
  if (ghEvent === 'star') {
    const repo = (body.repository as Record<string, unknown> | undefined)?.full_name ?? 'unknown'
    const sender = (body.sender as Record<string, unknown> | undefined)?.login ?? 'someone'
    return `⭐ **${repo}**: Starred by ${sender}`
  }
}

// Public incoming webhook endpoint (no auth — validated by token)
webhooksRouter.post('/webhooks/incoming/:token', async (c) => {
  const db = getDb()
  const { token } = c.req.param()
  const webhook = db.prepare('SELECT * FROM webhooks WHERE token = ?').get(token) as {
    id: string; channel_id: string; name: string; token: string;
    avatar: string | null; created_by: string; created_at: number
  } | undefined
  if (!webhook) return c.json({ error: 'invalid token' }, 401)

  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'invalid JSON body' }, 400)

  let content: string | undefined
  try {
    content = typeof body.content === 'string' ? body.content.trim() : undefined
    if (!content) {
      content = formatWebhookContent(c, body)
    }
  } catch (err: unknown) {
    console.error('[webhook] format error:', err instanceof Error ? err.message : String(err))
    return c.json({ error: 'Failed to parse webhook payload' }, 400)
  }
  if (!content || content.length > 4000) return c.json({ error: 'content required (max 4000 chars)' }, 400)

  const username = typeof body.username === 'string' ? body.username.trim() || null : null
  const avatarUrl = typeof body.avatar_url === 'string' ? body.avatar_url.trim() || null : null

  const displayName = username || webhook.name
  const avatar = avatarUrl ?? webhook.avatar ?? null

  const messageId = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  try {
    db.prepare(`INSERT INTO messages (id, channel_id, author_id, content, author_username, author_display_name, author_avatar, webhook_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      messageId, webhook.channel_id, '', content,
      webhook.name, displayName, avatar, webhook.id, now
    )
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
    avatar: avatar,
    created_at: now * 1000,
    edited_at: null, reply_to_message_id: null, reply_to_username: null, reply_to_content: null,
    reactions: [],
  }

  emitToRoom(c, webhook.channel_id, 'message:new', message as never)

  return c.json({ ok: true, messageId })
})

export default webhooksRouter
