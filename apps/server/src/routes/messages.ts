import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, canWriteToChannel } from '../middleware/auth'
import { parseMentions, processMentions } from '../socket/chatHandler'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const messageRoutes = new Hono()

function mapMessage(row: any) {
  return {
    id: row.id,
    channel_id: row.channel_id,
    user_id: row.author_id,
    username: row.author_username,
    display_name: row.display_name || row.author_username,
    avatar: row.avatar || undefined,
    content: row.content,
    edited_at: row.edited_at ? row.edited_at * 1000 : null,
    created_at: row.created_at * 1000,
    reactions: row.reactions ? JSON.parse(row.reactions) : [],
    reply_to_message_id: row.reply_to_message_id || null,
    reply_to_username: row.reply_to_username || null,
    reply_to_content: row.reply_to_content || null,
  }
}

function fetchReactionsForMessages(db: any, messageIds: string[]): Record<string, any[]> {
  if (messageIds.length === 0) return {}
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT mr.message_id, mr.reaction_key, mr.reaction_type, mr.user_id, u.username
    FROM message_reactions mr
    LEFT JOIN users u ON mr.user_id = u.id
    WHERE mr.message_id IN (${placeholders})
    ORDER BY mr.created_at
  `).all(...messageIds) as any[]

  const map: Record<string, any[]> = {}
  for (const r of rows) {
    if (!map[r.message_id]) map[r.message_id] = []
    const existing = map[r.message_id]!.find((e: any) => e.reaction_key === r.reaction_key && e.reaction_type === r.reaction_type)
    if (existing) {
      existing.count++
      existing.users.push({ user_id: r.user_id, username: r.username })
    } else {
      map[r.message_id]!.push({
        reaction_key: r.reaction_key,
        reaction_type: r.reaction_type,
        count: 1,
        users: [{ user_id: r.user_id, username: r.username }],
      })
    }
  }
  return map
}

// GET /messages/:channelId — fetch messages with ?limit= and ?before= pagination
messageRoutes.get('/:channelId', authMiddleware, (c) => {
  const channelId = c.req.param('channelId')
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const before = c.req.query('before')
  const db = getDb()

  const SELECT = `
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.channel_id = ?`

  let rows: any[]
  if (before) {
    const anchor = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(before) as { created_at: number } | undefined
    rows = anchor
      ? db.prepare(`${SELECT} AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`).all(channelId, anchor.created_at, limit) as any[]
      : []
    rows = rows.reverse()
  } else {
    rows = db.prepare(`${SELECT} ORDER BY m.created_at DESC LIMIT ?`).all(channelId, limit) as any[]
    rows = rows.reverse()
  }

  const messages = rows.map(mapMessage)
  const hasMore = rows.length === limit
  const messageIds = messages.map(m => m.id)
  const reactionsMap = fetchReactionsForMessages(db, messageIds)
  for (const msg of messages) {
    msg.reactions = reactionsMap[msg.id] || []
  }

  return c.json({ messages, hasMore })
})

// POST /messages/:channelId — send message
messageRoutes.post('/:channelId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!

  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'send_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (!canWriteToChannel(user.userId, channelId)) {
    return c.json({ error: 'This channel is locked' }, 403)
  }

  const body = await c.req.json() as { content: string; attachment_ids?: string[]; reply_to_message_id?: string }
  const { content, attachment_ids, reply_to_message_id } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Message too long (max 4000 chars)' }, 400)

  const db = getDb()
  const id = uuidv4()

  let replyUsername: string | null = null
  let replyContent: string | null = null
  if (reply_to_message_id) {
    const replyMsg = db.prepare('SELECT author_username, content FROM messages WHERE id = ? AND channel_id = ?').get(reply_to_message_id, channelId) as any
    if (replyMsg) {
      replyUsername = replyMsg.author_username
      replyContent = replyMsg.content
    }
  }

  db.prepare(
    'INSERT INTO messages (id, channel_id, author_id, author_username, content, reply_to_message_id, reply_to_username, reply_to_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, user.userId, user.username, content.trim(), reply_to_message_id || null, replyUsername, replyContent)

  if (attachment_ids && attachment_ids.length > 0) {
    for (const attId of attachment_ids) {
      db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL').run(id, attId)
    }
  }

  const row = db.prepare(`
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.id = ?
  `).get(id) as any

  const message = mapMessage(row)
  message.reactions = []

  try {
    const io: any = c.get('io' as never)
    if (io) {
      io.to(channelId).emit('message:new', message)
      io.to('__notifications__').emit('message:new', message)
    }
  } catch { /* best-effort */ }

  const mentions = parseMentions(content.trim())
  try {
    const io: any = c.get('io' as never)
    if (io) processMentions(io, { ...row, author_id: row.author_id, author_username: row.author_username }, mentions)
  } catch { /* best-effort */ }

  return c.json({ message }, 201)
})

// DELETE /messages/:messageId — delete message
messageRoutes.delete('/:messageId', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  const messageId = c.req.param('messageId')
  const db = getDb()

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any
  if (!message) return c.json({ error: 'Message not found' }, 404)

  if (message.author_id !== user.userId) {
    if (!userPerms || !hasPermission(userPerms, 'delete_messages')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId) as any[]
  for (const att of attachments) {
    const filepath = path.join(uploadsDir, path.basename(att.url))
    try { fs.unlinkSync(filepath) } catch { /* file may not exist */ }
  }

  db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM mentions WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM message_edits WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)

  try {
    const io: any = c.get('io' as never)
    if (io) {
      io.to(message.channel_id).emit('message:delete', { id: messageId, channel_id: message.channel_id })
      io.to('__notifications__').emit('message:delete', { id: messageId, channel_id: message.channel_id })
    }
  } catch { /* best-effort */ }

  return c.json({ ok: true })
})

// PATCH /messages/:messageId — edit message
messageRoutes.patch('/:messageId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId')
  if (!messageId) return c.json({ error: 'Message ID is required' }, 400)
  const body = await c.req.json() as { content: string }
  const { content } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Message too long (max 4000 chars)' }, 400)

  const db = getDb()
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any
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

  const result = mapMessage(row)
  result.reactions = fetchReactionsForMessages(db, [messageId])[messageId] || []

  try {
    const io: any = c.get('io' as never)
    if (io) {
      io.to(message.channel_id).emit('message:edit', result)
      io.to('__notifications__').emit('message:edit', result)
    }
  } catch { /* best-effort */ }

  return c.json({ message: result })
})

export default messageRoutes
