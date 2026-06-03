import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const dmRoutes = new Hono()

// GET /dms — list DM channels for the authenticated user
dmRoutes.get('/', authMiddleware, (c) => {
  const user = getAuth(c)
  const db = getDb()
  const channels = db.prepare(`
    SELECT dc.*,
      CASE WHEN dc.user1_id = ? THEN u2.username ELSE u1.username END as other_username,
      CASE WHEN dc.user1_id = ? THEN u2.display_name ELSE u1.display_name END as other_display_name,
      CASE WHEN dc.user1_id = ? THEN u2.avatar ELSE u1.avatar END as other_avatar,
      CASE WHEN dc.user1_id = ? THEN u2.id ELSE u1.id END as other_user_id
    FROM dm_channels dc
    JOIN users u1 ON dc.user1_id = u1.id
    JOIN users u2 ON dc.user2_id = u2.id
    WHERE dc.user1_id = ? OR dc.user2_id = ?
    ORDER BY dc.last_message_at DESC
  `).all(user.userId, user.userId, user.userId, user.userId, user.userId, user.userId) as any[]

  const result = channels.map((row: any) => ({
    id: row.id,
    other_user_id: row.other_user_id,
    other_username: row.other_username,
    other_display_name: row.other_display_name,
    other_avatar: row.other_avatar || null,
    created_at: row.created_at * 1000,
    last_message_at: row.last_message_at ? row.last_message_at * 1000 : null,
  }))

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

  let channel = db.prepare(
    'SELECT * FROM dm_channels WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)'
  ).get(user.userId, targetUserId, targetUserId, user.userId) as any

  if (!channel) {
    const id = uuidv4()
    db.prepare('INSERT INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(id, user.userId, targetUserId)
    channel = db.prepare('SELECT * FROM dm_channels WHERE id = ?').get(id) as any
  }

  return c.json({
    channel: {
      id: channel.id,
      other_user_id: targetUser.id,
      other_username: targetUser.username,
      other_display_name: targetUser.display_name,
      other_avatar: targetUser.avatar || null,
      created_at: channel.created_at * 1000,
      last_message_at: channel.last_message_at ? channel.last_message_at * 1000 : null,
    },
  })
})

// GET /dms/channel/:channelId/messages
dmRoutes.get('/channel/:channelId/messages', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')
  const limit = parseInt(c.req.query('limit') || '50', 10)
  const db = getDb()

  const channel = db.prepare('SELECT * FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)').get(channelId, user.userId, user.userId) as any
  if (!channel) return c.json({ error: 'Not found' }, 404)

  const messages = db.prepare(`
    SELECT dm.*, u.display_name, u.avatar
    FROM direct_messages dm
    LEFT JOIN users u ON dm.from_id = u.id
    WHERE (dm.channel_id = ?) OR (dm.from_id = ? AND dm.to_id = ?) OR (dm.from_id = ? AND dm.to_id = ?)
    ORDER BY dm.created_at DESC
    LIMIT ?
  `).all(channelId, user.userId, channel.user1_id === user.userId ? channel.user2_id : channel.user1_id, channel.user1_id === user.userId ? channel.user2_id : channel.user1_id, user.userId, limit) as any[]

  const result = messages.reverse().map((row: any) => ({
    id: row.id,
    channel_id: row.channel_id || channelId,
    user_id: row.from_id,
    username: row.from_username,
    display_name: row.display_name || row.from_username,
    avatar: row.avatar || undefined,
    content: row.content,
    created_at: row.created_at * 1000,
  }))

  return c.json({ messages: result })
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
  const id = uuidv4()

  db.prepare(
    'INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, user.userId, user.username, toId, content.trim())

  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?').run(now, channelId)

  const message = {
    id,
    channel_id: channelId,
    user_id: user.userId,
    username: user.username,
    display_name: user.displayName,
    content: content.trim(),
    created_at: Date.now(),
  }

  return c.json({ message }, 201)
})

export default dmRoutes
