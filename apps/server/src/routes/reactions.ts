import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const reactionRoutes = new Hono()

const DEFAULT_EMOJIS = ['👍', '❤️', '😆', '😮', '😢']

function getMessageInfo(db: any, messageId: string): { channel_id: string; isDM: boolean; participants?: { user1_id: string; user2_id: string } } | null {
  const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId) as any
  if (msg) return { channel_id: msg.channel_id, isDM: false }

  const dm = db.prepare(`
    SELECT dm.channel_id, dc.user1_id, dc.user2_id
    FROM direct_messages dm
    JOIN dm_channels dc ON dc.id = dm.channel_id
    WHERE dm.id = ?
  `).get(messageId) as any
  if (dm) return { channel_id: dm.channel_id, isDM: true, participants: { user1_id: dm.user1_id, user2_id: dm.user2_id } }

  return null
}

function getReactionsForMessage(db: any, messageId: string): any[] {
  const rows = db.prepare(`
    SELECT mr.reaction_key, mr.reaction_type, mr.user_id, u.username
    FROM message_reactions mr
    LEFT JOIN users u ON mr.user_id = u.id
    WHERE mr.message_id = ?
    ORDER BY mr.created_at
  `).all(messageId) as any[]

  const reactions: any[] = []
  for (const r of rows) {
    const existing = reactions.find(e => e.reaction_key === r.reaction_key && e.reaction_type === r.reaction_type)
    if (existing) {
      existing.count++
      existing.users.push({ user_id: r.user_id, username: r.username })
    } else {
      reactions.push({
        reaction_key: r.reaction_key,
        reaction_type: r.reaction_type,
        count: 1,
        users: [{ user_id: r.user_id, username: r.username }],
      })
    }
  }
  return reactions
}

function findReaction(db: any, messageId: string, userId: string, reactionKey: string): any {
  return db.prepare(
    'SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_key = ?'
  ).get(messageId, userId, reactionKey)
}

// POST /api/reactions/:messageId — add a reaction
reactionRoutes.post('/:messageId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId') || ''
  const body = await c.req.json() as { reaction_key: string; reaction_type?: string }
  const { reaction_key, reaction_type } = body
  if (!reaction_key) return c.json({ error: 'reaction_key is required' }, 400)
  if (!messageId) return c.json({ error: 'Message ID is required' }, 400)

  const db = getDb()
  const msgInfo = getMessageInfo(db, messageId)
  if (!msgInfo) return c.json({ error: 'Message not found' }, 404)

  if (!msgInfo.isDM) {
    const userPerms = getUserPermissions(user.userId)
    if (!userPerms || !hasPermission(userPerms, 'add_reactions')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  const existing = findReaction(db, messageId, user.userId, reaction_key)
  if (existing) return c.json({ error: 'Already reacted' }, 409)

  const type = reaction_type || 'emoji'
  db.prepare(
    'INSERT INTO message_reactions (message_id, user_id, reaction_key, reaction_type) VALUES (?, ?, ?, ?)'
  ).run(messageId, user.userId, reaction_key, type)

  const reactions = getReactionsForMessage(db, messageId)

  try {
    const io: any = c.get('io' as never)
    if (io) {
      const payload = {
        messageId,
        channelId: msgInfo.channel_id,
        reaction: { reaction_key, reaction_type: type, userId: user.userId, username: user.username },
      }
      if (msgInfo.isDM && msgInfo.participants) {
        io.to(`dm:${msgInfo.participants.user1_id}`).emit('message:react:add', payload)
        io.to(`dm:${msgInfo.participants.user2_id}`).emit('message:react:add', payload)
      } else {
        io.to(msgInfo.channel_id).emit('message:react:add', payload)
      }
    }
  } catch {}

  return c.json({ reactions })
})

// DELETE /api/reactions/:messageId/:reactionKey — remove own reaction
reactionRoutes.delete('/:messageId/:reactionKey', authMiddleware, (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId') || ''
  const reactionKey = c.req.param('reactionKey') || ''
  if (!messageId) return c.json({ error: 'Message ID is required' }, 400)
  if (!reactionKey) return c.json({ error: 'Reaction key is required' }, 400)

  const db = getDb()
  const msgInfo = getMessageInfo(db, messageId)
  if (!msgInfo) return c.json({ error: 'Message not found' }, 404)

  const existing = findReaction(db, messageId, user.userId, reactionKey)
  if (!existing) return c.json({ error: 'Reaction not found' }, 404)

  db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_key = ?')
    .run(messageId, user.userId, reactionKey)

  const reactions = getReactionsForMessage(db, messageId)

  try {
    const io: any = c.get('io' as never)
    if (io) {
      const payload = {
        messageId,
        channelId: msgInfo.channel_id,
        reactionKey,
        userId: user.userId,
      }
      if (msgInfo.isDM && msgInfo.participants) {
        io.to(`dm:${msgInfo.participants.user1_id}`).emit('message:react:remove', payload)
        io.to(`dm:${msgInfo.participants.user2_id}`).emit('message:react:remove', payload)
      } else {
        io.to(msgInfo.channel_id).emit('message:react:remove', payload)
      }
    }
  } catch {}

  return c.json({ reactions })
})

// GET /api/reactions/popular — get user's top 5 emojis + server popular, and top stickers
reactionRoutes.get('/popular', authMiddleware, (c) => {
  const user = getAuth(c)
  const db = getDb()

  // Get user's top 5 emoji reactions
  const userTop = db.prepare(`
    SELECT reaction_key, COUNT(*) as cnt
    FROM message_reactions
    WHERE user_id = ? AND reaction_type = 'emoji'
    GROUP BY reaction_key
    ORDER BY cnt DESC, reaction_key
    LIMIT 5
  `).all(user.userId) as { reaction_key: string; cnt: number }[]

  // Get user's top 3 sticker reactions
  const userStickers = db.prepare(`
    SELECT mr.reaction_key, COUNT(*) as cnt, g.stored_filename
    FROM message_reactions mr
    LEFT JOIN gifs g ON g.id = mr.reaction_key
    WHERE mr.user_id = ? AND mr.reaction_type = 'sticker'
    GROUP BY mr.reaction_key
    ORDER BY cnt DESC
    LIMIT 3
  `).all(user.userId) as { reaction_key: string; cnt: number; stored_filename: string | null }[]

  let emojis: string[] = userTop.map(r => r.reaction_key)
  if (emojis.length < 5) {
    for (const e of DEFAULT_EMOJIS) {
      if (!emojis.includes(e)) emojis.push(e)
      if (emojis.length >= 5) break
    }
  }

  const stickers = userStickers.map(r => ({
    id: r.reaction_key,
    url: r.stored_filename ? `/api/gifs/${r.reaction_key}/file` : '',
  }))

  return c.json({ emojis, stickers })
})

export default reactionRoutes
