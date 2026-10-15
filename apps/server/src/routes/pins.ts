import { Hono } from 'hono'
import { getDb } from '../db'
import {
  authMiddleware,
  canViewChannel,
  canWriteToChannel,
  getUserChannelPermission,
} from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import type { Server as IoServer } from 'socket.io'
import { getAuth } from '../utils/auth'
import { getIo } from '../utils/io'

function broadcastPin(
  io: IoServer | undefined,
  channelId: string,
  event: string,
  data: Record<string, unknown>,
) {
  if (io) {
    io.to(channelId).emit(event, data as never)
  }
}

// A channel the caller can actually see. canViewChannel() answers true for
// unknown ids, so existence has to be checked separately.
function channelVisible(userId: string, channelId: string): boolean {
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM channels WHERE id = ?').get(channelId)
  return !!exists && canViewChannel(userId, channelId)
}

// Authors may pin their own messages; pinning anyone else's is a moderator
// action (delete_messages, resolved with channel overrides). Mirrors the
// socket pin path in socket/chat/reactions.ts so both entry points agree.
function canManagePins(userId: string, channelId: string, authorId: string | null): boolean {
  if (!canWriteToChannel(userId, channelId)) return false
  return authorId === userId || getUserChannelPermission(userId, channelId, 'delete_messages')
}

const pinsRoutes = new Hono()

pinsRoutes.get('/:channelId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  if (!channelVisible(user.userId, channelId)) return c.json({ error: 'Channel not found' }, 404)
  const db = getDb()
  const rows = db
    .prepare(
      `
    SELECT p.*, m.content, m.author_id, m.author_username, u.display_name, u.avatar
    FROM pinned_messages p
    JOIN messages m ON p.message_id = m.id
    LEFT JOIN users u ON m.author_id = u.id
    WHERE p.channel_id = ?
    ORDER BY p.pinned_at DESC
  `,
    )
    .all(channelId) as {
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

  const pins = rows.map((r) => ({
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
  const channelId = c.req.param('channelId')!
  const messageId = c.req.param('messageId')!
  if (!channelVisible(user.userId, channelId)) return c.json({ error: 'Channel not found' }, 404)
  const db = getDb()

  const msg = db
    .prepare(
      'SELECT content, author_id, author_username FROM messages WHERE id = ? AND channel_id = ?',
    )
    .get(messageId, channelId) as
    | { content: string; author_id: string; author_username: string }
    | undefined
  if (!msg) return c.json({ error: 'Message not found' }, 404)
  if (!canManagePins(user.userId, channelId, msg.author_id)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const existing = db
    .prepare('SELECT id FROM pinned_messages WHERE channel_id = ? AND message_id = ?')
    .get(channelId, messageId)
  if (existing) return c.json({ error: 'Already pinned' }, 400)

  const count = db
    .prepare('SELECT COUNT(*) as count FROM pinned_messages WHERE channel_id = ?')
    .get(channelId) as { count: number }
  if (count.count >= 50) return c.json({ error: 'Maximum 50 pins per channel' }, 400)

  const id = uuidv4()
  db.prepare(
    'INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)',
  ).run(id, channelId, messageId, user.userId)

  const pin = {
    id,
    messageId,
    channelId,
    pinnedBy: user.userId,
    pinnedByUsername: user.username,
    pinnedAt: Date.now(),
    content: msg.content,
    authorId: msg.author_id,
    authorUsername: msg.author_username,
  }

  const io = getIo(c)
  broadcastPin(io, channelId, 'message:pin', pin)

  return c.json({ success: true, id })
})

pinsRoutes.delete('/:channelId/:messageId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const messageId = c.req.param('messageId')!
  if (!channelVisible(user.userId, channelId)) return c.json({ error: 'Channel not found' }, 404)
  const db = getDb()
  const target = db
    .prepare('SELECT author_id FROM messages WHERE id = ? AND channel_id = ?')
    .get(messageId, channelId) as { author_id: string } | undefined
  if (!canManagePins(user.userId, channelId, target?.author_id ?? null)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const result = db
    .prepare('DELETE FROM pinned_messages WHERE channel_id = ? AND message_id = ?')
    .run(channelId, messageId)
  if (result.changes === 0) return c.json({ error: 'Pin not found' }, 404)

  const io = getIo(c)
  broadcastPin(io, channelId, 'message:unpin', { channelId, messageId })

  return c.json({ success: true })
})

export default pinsRoutes
export { pinsRoutes }
