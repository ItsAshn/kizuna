import { Hono } from 'hono'
import type { Context } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import type { AuthUser } from '../types'
import type { Server as IoServer } from 'socket.io'

function getAuth(c: Context): AuthUser { return c.get('auth') }

function broadcastPin(io: IoServer | undefined, channelId: string, event: string, data: Record<string, unknown>) {
  if (io) {
    io.to(channelId).emit(event, data as never)
  }
}

const pinsRoutes = new Hono()

pinsRoutes.get('/:channelId', authMiddleware, (c) => {
  const channelId = c.req.param('channelId')
  const db = getDb()
  const rows = db.prepare(`
    SELECT p.*, m.content, m.author_id, m.author_username, u.display_name, u.avatar
    FROM pinned_messages p
    JOIN messages m ON p.message_id = m.id
    LEFT JOIN users u ON m.author_id = u.id
    WHERE p.channel_id = ?
    ORDER BY p.pinned_at DESC
  `).all(channelId) as {
    id: string
    message_id: string
    channel_id: string
    pinned_by: string
    pinned_at: number
    content: string
    author_id: string
    author_username: string
    display_name: string | null
    avatar: string | null
  }[]

  const pins = rows.map(r => ({
    id: r.id,
    messageId: r.message_id,
    channelId: r.channel_id,
    pinnedBy: r.pinned_by,
    pinnedAt: r.pinned_at * 1000,
    content: r.content,
    authorId: r.author_id,
    authorUsername: r.author_username,
    authorDisplayName: r.display_name || r.author_username,
    authorAvatar: r.avatar || undefined,
  }))

  return c.json({ pins })
})

pinsRoutes.post('/:channelId/:messageId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')
  const messageId = c.req.param('messageId')
  const db = getDb()

  const existing = db.prepare('SELECT id FROM pinned_messages WHERE channel_id = ? AND message_id = ?').get(channelId, messageId)
  if (existing) return c.json({ error: 'Already pinned' }, 400)

  const count = db.prepare('SELECT COUNT(*) as count FROM pinned_messages WHERE channel_id = ?').get(channelId) as { count: number }
  if (count.count >= 50) return c.json({ error: 'Maximum 50 pins per channel' }, 400)

  const id = uuidv4()
  db.prepare('INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)').run(id, channelId, messageId, user.userId)

  const msg = db.prepare('SELECT content, author_id, author_username FROM messages WHERE id = ?').get(messageId) as { content: string; author_id: string; author_username: string } | undefined
  const pin = {
    id,
    messageId,
    channelId,
    pinnedBy: user.userId,
    pinnedByUsername: user.username,
    pinnedAt: Date.now(),
    content: msg?.content || '',
    authorId: msg?.author_id || '',
    authorUsername: msg?.author_username || '',
  }

  const io = c.get('io' as never) as IoServer | undefined
  broadcastPin(io, channelId!, 'message:pin', pin)

  return c.json({ success: true, id })
})

pinsRoutes.delete('/:channelId/:messageId', authMiddleware, (c) => {
  const channelId = c.req.param('channelId')
  const messageId = c.req.param('messageId')
  const db = getDb()

  db.prepare('DELETE FROM pinned_messages WHERE channel_id = ? AND message_id = ?').run(channelId, messageId)

  const io = c.get('io' as never) as IoServer | undefined
  broadcastPin(io, channelId!, 'message:unpin', { channelId, messageId })

  return c.json({ success: true })
})

export default pinsRoutes
export { pinsRoutes }
