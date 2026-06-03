import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const messageRoutes = new Hono()

// GET /messages/:channelId — fetch messages
messageRoutes.get('/:channelId', authMiddleware, (c) => {
  const channelId = c.req.param('channelId')
  const limit = parseInt(c.req.query('limit') || '50', 10)
  const db = getDb()

  const messages = db.prepare(`
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.channel_id = ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(channelId, limit) as any[]

  const result = messages.reverse().map((row) => ({
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.author_id,
    username: row.author_username,
    display_name: row.display_name || row.author_username,
    avatar: row.avatar || undefined,
    content: row.content,
    edited_at: row.edited_at ? row.edited_at * 1000 : null,
    updated_at: row.updated_at ? row.updated_at * 1000 : null,
    created_at: row.created_at * 1000,
  }))

  return c.json({ messages: result })
})

// POST /messages/:channelId — send message
messageRoutes.post('/:channelId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'send_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const channelId = c.req.param('channelId')
  const body = await c.req.json() as { content: string }
  const { content } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Message too long (max 4000 chars)' }, 400)

  const db = getDb()
  const id = uuidv4()
  db.prepare(
    'INSERT INTO messages (id, channel_id, author_id, author_username, content) VALUES (?, ?, ?, ?, ?)'
  ).run(id, channelId, user.userId, user.username, content.trim())

  const row = db.prepare(`
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.id = ?
  `).get(id) as any

  const message = {
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.author_id,
    username: row.author_username,
    display_name: row.display_name || row.author_username,
    avatar: row.avatar || undefined,
    content: row.content,
    created_at: row.created_at * 1000,
  }

  return c.json({ message }, 201)
})

// DELETE /messages/:messageId — delete message
messageRoutes.delete('/:messageId', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  const messageId = c.req.param('messageId')
  const db = getDb()

  const message = db.prepare('SELECT author_id FROM messages WHERE id = ?').get(messageId) as { author_id: string } | undefined
  if (!message) return c.json({ error: 'Message not found' }, 404)

  if (message.author_id !== user.userId) {
    if (!userPerms || !hasPermission(userPerms, 'delete_messages')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  // Save edit history before deleting
  const oldMessage = db.prepare('SELECT content FROM messages WHERE id = ?').get(messageId) as { content: string } | undefined
  if (oldMessage) {
    db.prepare(
      'INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuidv4(), messageId, oldMessage.content, user.userId, Math.floor(Date.now() / 1000))
  }

  db.prepare('DELETE FROM mentions WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
  return c.json({ ok: true })
})

// PATCH /messages/:messageId — edit message
messageRoutes.patch('/:messageId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId')
  const body = await c.req.json() as { content: string }
  const { content } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Message too long (max 4000 chars)' }, 400)

  const db = getDb()
  const message = db.prepare('SELECT author_id, content FROM messages WHERE id = ?').get(messageId) as { author_id: string; content: string } | undefined
  if (!message) return c.json({ error: 'Message not found' }, 404)
  if (message.author_id !== user.userId) return c.json({ error: 'Forbidden' }, 403)

  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), messageId, message.content, user.userId, now)
  db.prepare('UPDATE messages SET content = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(content.trim(), now, now, messageId)

  const row = db.prepare(`
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.id = ?
  `).get(messageId) as any

  const result = {
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.author_id,
    username: row.author_username,
    display_name: row.display_name || row.author_username,
    avatar: row.avatar || undefined,
    content: row.content,
    edited_at: row.edited_at ? row.edited_at * 1000 : null,
    created_at: row.created_at * 1000,
  }

  return c.json({ message: result })
})

export default messageRoutes
