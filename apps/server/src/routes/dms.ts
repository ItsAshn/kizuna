import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

function getOrCreateDMChannel(db: any, userId: string, otherUserId: string) {
  const sortedIds = [userId, otherUserId].sort()
  let channel = db.prepare(
    'SELECT * FROM dm_channels WHERE user1_id = ? AND user2_id = ?'
  ).get(sortedIds[0], sortedIds[1])

  if (!channel) {
    const id = uuidv4()
    db.prepare('INSERT INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(id, sortedIds[0], sortedIds[1])
    channel = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id)
  }

  return channel
}

function formatDMChannel(channel: any, currentUserId: string) {
  const db = getDb()
  const otherUserId = channel.user1_id === currentUserId ? channel.user2_id : channel.user1_id
  const otherUser = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?').get(otherUserId) as any

  return {
    id: channel.id,
    other_user_id: otherUserId,
    other_username: otherUser?.username || 'Unknown',
    other_display_name: otherUser?.display_name || otherUser?.username || 'Unknown',
    other_avatar: otherUser?.avatar || null,
    created_at: channel.created_at * 1000,
    last_message_at: channel.last_message_at ? channel.last_message_at * 1000 : null,
  }
}

const dmRoutes = new Hono()

// GET /dms — list DM channels for the authenticated user
dmRoutes.get('/', authMiddleware, (c) => {
  const user = getAuth(c)
  const db = getDb()
  const channels = db.prepare(
    'SELECT * FROM dm_channels WHERE user1_id = ? OR user2_id = ? ORDER BY last_message_at DESC'
  ).all(user.userId, user.userId) as any[]

  const result = channels.map((ch) => formatDMChannel(ch, user.userId))
  return c.json({ channels: result })
})

// GET /dms/:userId — get or create a DM channel with this user
dmRoutes.get('/:userId', authMiddleware, (c) => {
  const user = getAuth(c)
  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)
  if (targetUserId === user.userId) return c.json({ error: 'Cannot DM yourself' }, 400)

  const db = getDb()
  const targetUser = db.prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?').get(targetUserId) as any
  if (!targetUser) return c.json({ error: 'User not found' }, 404)

  const channel = getOrCreateDMChannel(db, user.userId, targetUserId)
  return c.json({ channel: formatDMChannel(channel, user.userId) })
})

// GET /dms/channel/:channelId/messages
dmRoutes.get('/channel/:channelId/messages', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const before = c.req.query('before')
  const db = getDb()

  const channel = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(channelId) as any
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  if (channel.user1_id !== user.userId && channel.user2_id !== user.userId) {
    return c.json({ error: 'Not authorized' }, 403)
  }

  let rows: any[]
  if (before) {
    const anchor = db.prepare('SELECT created_at FROM direct_messages WHERE id = ?').get(before) as { created_at: number } | undefined
    rows = anchor
      ? db.prepare(
          `SELECT dm.*, u.display_name FROM direct_messages dm
           LEFT JOIN users u ON dm.from_id = u.id
           WHERE dm.channel_id = ? AND dm.created_at < ?
           ORDER BY dm.created_at DESC LIMIT ?`
        ).all(channelId, anchor.created_at, limit) as any[]
      : []
    rows = rows.reverse()
  } else {
    rows = db.prepare(
      `SELECT dm.*, u.display_name FROM direct_messages dm
       LEFT JOIN users u ON dm.from_id = u.id
       WHERE dm.channel_id = ?
       ORDER BY dm.created_at DESC LIMIT ?`
    ).all(channelId, limit) as any[]
    rows = rows.reverse()
  }

  const messages = rows.map((row) => ({
    id: row.id,
    channel_id: channelId,
    user_id: row.from_id,
    username: row.from_username,
    display_name: row.display_name || row.from_username,
    content: row.content,
    created_at: row.created_at * 1000,
  }))

  return c.json({ messages })
})

// POST /dms/channel/:channelId/messages
dmRoutes.post('/channel/:channelId/messages', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')
  const body = await c.req.json() as { content: string }
  const { content } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Message too long' }, 400)

  const db = getDb()
  const channel = db.prepare('SELECT * FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)').get(channelId, user.userId, user.userId) as any
  if (!channel) return c.json({ error: 'Channel not found' }, 404)

  const toId = channel.user1_id === user.userId ? channel.user2_id : channel.user1_id

  const otherMember = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(toId)
  if (!otherMember) return c.json({ error: 'Recipient is not a server member' }, 400)

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)

  db.prepare(
    'INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, user.userId, user.username, toId, content.trim(), now)

  db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?').run(now, channelId)

  const message = {
    id,
    channel_id: channelId,
    user_id: user.userId,
    username: user.username,
    display_name: user.displayName,
    content: content.trim(),
    created_at: now * 1000,
  }

  try {
    const io: any = c.get('io' as never)
    if (io) {
      io.to(`dm:${toId}`).emit('dm:received', message)
      io.to(`user:${user.userId}`).emit('dm:sent', message)
    }
  } catch { /* emit is best-effort */ }

  return c.json({ message }, 201)
})

export default dmRoutes
