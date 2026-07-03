import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs/promises'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, canWriteToChannel, canViewChannel, isUserAdmin } from '../middleware/auth'
import { checkSpam } from '../services/spamFilter'
import { parseMentions, processMentions } from '../socket/chatHandler'
import { checkMessageContent } from '../moderation'
import type { AuthUser } from '../middleware/auth'
import type { Context } from 'hono'
import type { Server as IOServer } from 'socket.io'
import type Database from 'better-sqlite3'

interface ReactionRow {
  message_id: string
  reaction_key: string
  reaction_type: string
  user_id: string
  username: string
}

interface ReactionGroup {
  _key?: string
  reaction_key: string
  reaction_type: string
  count: number
  users: Array<{ user_id: string; username: string }>
}

interface AttachmentRow {
  url: string
}

function getAuth(c: Context): AuthUser { return c.get('auth' as never) as AuthUser }

const messageRoutes = new Hono()

function mapMessage(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    channel_id: row.channel_id as string,
    user_id: (row.author_id as string) || null,
    username: row.author_username as string,
    display_name: (row.author_display_name as string | null) || (row.display_name as string | null) || (row.author_username as string),
    avatar: (row.author_avatar as string | null) || (row.avatar as string | null | undefined) || undefined,
    content: row.content as string,
    edited_at: row.edited_at ? (row.edited_at as number) * 1000 : null,
    created_at: (row.created_at as number) * 1000,
    reactions: row.reactions ? JSON.parse(row.reactions as string) : [],
    reply_to_message_id: (row.reply_to_message_id as string) || null,
    reply_to_username: (row.reply_to_username as string) || null,
    reply_to_content: (row.reply_to_content as string) || null,
    webhook_id: (row.webhook_id as string) || null,
  }
}

function fetchReactionsForMessages(db: Database.Database, messageIds: string[]): Record<string, ReactionGroup[]> {
  if (messageIds.length === 0) return {}
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT mr.message_id, mr.reaction_key, mr.reaction_type, mr.user_id, u.username
    FROM message_reactions mr
    LEFT JOIN users u ON mr.user_id = u.id
    WHERE mr.message_id IN (${placeholders})
    ORDER BY mr.created_at
  `).all(...messageIds) as ReactionRow[]

  const map: Record<string, ReactionGroup[]> = {}
  for (const r of rows) {
    if (!map[r.message_id]) map[r.message_id] = []
    const msgReactions = map[r.message_id]!
    const key = `${r.reaction_key}:${r.reaction_type}`
    let found = false
    for (let i = 0; i < msgReactions.length; i++) {
      const e = msgReactions[i]!
      if (e._key === key) {
        e.count++
        e.users.push({ user_id: r.user_id, username: r.username })
        found = true
        break
      }
    }
    if (!found) {
      const reaction = {
        _key: key,
        reaction_key: r.reaction_key,
        reaction_type: r.reaction_type,
        count: 1,
        users: [{ user_id: r.user_id, username: r.username }],
      }
      msgReactions.push(reaction)
    }
  }
  for (const arr of Object.values(map)) {
    for (const r of arr) delete r._key
  }
  return map
}

// GET /messages/:channelId — fetch messages with ?limit= and ?before= pagination
messageRoutes.get('/:channelId', authMiddleware, (c) => {
  const channelId = c.req.param('channelId')!
  const user = getAuth(c)
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const before = c.req.query('before')

  if (!canViewChannel(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }

  const db = getDb()

  const SELECT = `
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.channel_id = ?`

  let rows: Record<string, unknown>[]
  if (before) {
    const anchor = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(before) as { created_at: number } | undefined
    rows = anchor
      ? db.prepare(`${SELECT} AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?`).all(channelId, anchor.created_at, limit) as Record<string, unknown>[]
      : []
    rows = rows.reverse()
  } else {
    rows = db.prepare(`${SELECT} ORDER BY m.created_at DESC LIMIT ?`).all(channelId, limit) as Record<string, unknown>[]
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
  if (!canViewChannel(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }
  if (!canWriteToChannel(user.userId, channelId)) {
    return c.json({ error: 'This channel is locked' }, 403)
  }

  const body = await c.req.json() as { content: string; attachment_ids?: string[]; reply_to_message_id?: string }
  const { content, attachment_ids, reply_to_message_id } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Message too long (max 4000 chars)' }, 400)

  if (!isUserAdmin(user.userId)) {
    const spamResult = checkSpam(user.userId, channelId, content)
    if (!spamResult.allowed) {
      return c.json({ error: 'Message blocked by spam filter' }, 429)
    }
  }

  if (!checkMessageContent(content.trim()).allowed) {
    return c.json({ error: 'Message contains blocked content' }, 400)
  }

  const db = getDb()
  const id = uuidv4()

  let replyUsername: string | null = null
  let replyContent: string | null = null
  if (reply_to_message_id) {
    const replyMsg = db.prepare('SELECT author_username, content FROM messages WHERE id = ? AND channel_id = ?').get(reply_to_message_id, channelId) as { author_username: string; content: string } | undefined
    if (replyMsg) {
      replyUsername = replyMsg.author_username
      replyContent = replyMsg.content
    }
  }

  db.prepare(
    'INSERT INTO messages (id, channel_id, author_id, author_username, content, reply_to_message_id, reply_to_username, reply_to_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, user.userId, user.username, content.trim(), reply_to_message_id || null, replyUsername, replyContent)

  if (attachment_ids && attachment_ids.length > 0) {
    const updateStmt = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL')
    const tx = db.transaction(() => {
      for (const attId of attachment_ids) {
        updateStmt.run(id, attId)
      }
    })
    tx()
  }

  const row = db.prepare(`
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.id = ?
  `).get(id) as Record<string, unknown>

  const message = mapMessage(row)
  message.reactions = []

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      io.to(channelId).to('__notifications__').emit('message:new', message)
    }
  } catch { /* best-effort */ }

  const mentions = parseMentions(content.trim())
  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) processMentions(io, {
      id: row.id as string,
      channel_id: row.channel_id as string,
      author_id: row.author_id as string,
      author_username: row.author_username as string,
      content: row.content as string,
    }, mentions)
  } catch { /* best-effort */ }

  return c.json({ message }, 201)
})

// DELETE /messages/:messageId — delete message
messageRoutes.delete('/:messageId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  const messageId = c.req.param('messageId')
  const db = getDb()

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Record<string, unknown> | undefined
  if (!message) return c.json({ error: 'Message not found' }, 404)

  if (message.author_id !== user.userId) {
    if (!userPerms || !hasPermission(userPerms, 'delete_messages')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId) as AttachmentRow[]
  await Promise.all(attachments.map(async (att) => {
    const filepath = path.join(uploadsDir, path.basename(att.url))
    try { await fs.unlink(filepath) } catch { /* file may not exist */ }
  }))

  db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM mentions WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM message_edits WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      io.to(message.channel_id as string).to('__notifications__').emit('message:delete', { id: messageId, channel_id: message.channel_id as string })
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

  if (!checkMessageContent(content.trim()).allowed) {
    return c.json({ error: 'Message contains blocked content' }, 400)
  }

  const db = getDb()
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Record<string, unknown> | undefined
  if (!message) return c.json({ error: 'Message not found' }, 404)
  if (message.author_id !== user.userId) return c.json({ error: 'Forbidden' }, 403)

  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), messageId, message.content as string, user.userId, now)
  db.prepare('UPDATE messages SET content = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(content.trim(), now, now, messageId)

  const row = db.prepare(`
    SELECT m.*, u.display_name, u.avatar
    FROM messages m
    LEFT JOIN users u ON m.author_id = u.id
    WHERE m.id = ?
  `).get(messageId) as Record<string, unknown>

  const result = mapMessage(row)
  result.reactions = fetchReactionsForMessages(db, [messageId])[messageId] || []

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      io.to(message.channel_id as string).to('__notifications__').emit('message:edit', result)
    }
  } catch { /* best-effort */ }

  return c.json({ message: result })
})

export default messageRoutes
