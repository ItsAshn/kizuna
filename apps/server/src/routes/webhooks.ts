import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'

function getAuth(c: any): { userId: string; username: string } { return c.get('auth' as never) }

const webhooksRouter = new Hono()

// Management routes (require auth)
const authedRouter = new Hono()
authedRouter.use('*', authMiddleware)

authedRouter.post('/channels/:channelId/webhooks', async (c) => {
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

authedRouter.get('/channels/:channelId/webhooks', async (c) => {
  const db = getDb()
  const { channelId } = c.req.param()
  const rows = db.prepare('SELECT id, name, created_at FROM webhooks WHERE channel_id = ?').all(channelId)
  return c.json({ webhooks: rows })
})

authedRouter.delete('/webhooks/:webhookId', async (c) => {
  const db = getDb()
  const { webhookId } = c.req.param()
  const { userId } = getAuth(c)
  const webhook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(webhookId) as any
  if (!webhook) return c.json({ error: 'not found' }, 404)
  if (webhook.created_by !== userId) {
    const admin = db.prepare('SELECT role FROM members WHERE user_id = ? AND role = ?').get(userId, 'admin')
    if (!admin) return c.json({ error: 'forbidden' }, 403)
  }
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(webhookId)
  return c.json({ ok: true })
})

// Public incoming webhook endpoint (no auth — validated by token)
webhooksRouter.post('/webhooks/incoming/:token', async (c) => {
  const db = getDb()
  const { token } = c.req.param()
  const webhook = db.prepare('SELECT * FROM webhooks WHERE token = ?').get(token) as any
  if (!webhook) return c.json({ error: 'invalid token' }, 401)

  const body = await c.req.json().catch(() => null)
  const content = body?.content?.trim()
  if (!content || content.length > 4000) return c.json({ error: 'content required (max 4000 chars)' }, 400)

  const messageId = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, author_username, author_display_name, author_avatar, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    messageId, webhook.channel_id, webhook.created_by, content,
    webhook.name, webhook.name, webhook.avatar ?? null, now
  )

  const message = {
    id: messageId,
    channel_id: webhook.channel_id,
    user_id: webhook.created_by,
    content,
    author_username: webhook.name,
    author_display_name: webhook.name,
    author_avatar: webhook.avatar ?? null,
    created_at: now * 1000,
    edited_at: null, reply_to_id: null, reply_to_content: null, reply_to_username: null,
    reactions: [], attachments: [],
  }

  const io: any = c.get('io' as never)
  io?.to(webhook.channel_id).emit('message:new', message)

  return c.json({ ok: true, messageId })
})

webhooksRouter.route('/', authedRouter)

export default webhooksRouter
