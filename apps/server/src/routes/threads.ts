import { Hono } from 'hono'
import type { Context } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs/promises'
import { getDb } from '../db'
import {
  authMiddleware,
  canViewChannel,
  canWriteToChannel,
  getUserChannelPermission,
  getUserPermissions,
  hasPermission,
  isUserAdmin,
} from '../middleware/auth'
import { checkSpam } from '../services/spamFilter'
import { checkMessageContent } from '../moderation'
import { deleteMessageRows } from '../services/messageDeletion'
import { getAuth } from '../utils/auth'
import { getIo, emitToRoom } from '../utils/io'

const threadsRoutes = new Hono()

function parseLimit(raw: string | undefined, fallback = 50): number {
  const n = parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, 1), 100)
}

// The parent channel must exist and be visible to the caller. canViewChannel()
// answers true for unknown ids, so existence is checked separately.
function parentChannelVisible(userId: string, channelId: string): boolean {
  const exists = getDb().prepare('SELECT 1 FROM channels WHERE id = ?').get(channelId)
  return !!exists && canViewChannel(userId, channelId)
}

// Same gates as sending a channel message: lock, per-channel send permission
// (role overrides applied), then the spam filter and content moderation.
function checkCanPost(
  c: Context,
  userId: string,
  channelId: string,
  content: string | null,
): Response | null {
  if (!canWriteToChannel(userId, channelId)) {
    return c.json({ error: 'This channel is locked' }, 403)
  }
  if (!getUserChannelPermission(userId, channelId, 'send_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  if (content === null) return null
  if (!isUserAdmin(userId) && !checkSpam(userId, channelId, content).allowed) {
    return c.json({ error: 'Message blocked by spam filter' }, 429)
  }
  if (!checkMessageContent(content).allowed) {
    return c.json({ error: 'Message contains blocked content' }, 400)
  }
  return null
}

threadsRoutes.get('/:channelId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  if (!parentChannelVisible(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM threads WHERE channel_id = ? ORDER BY last_message_at DESC')
    .all(channelId) as {
    id: string
    channel_id: string
    name: string
    creator_id: string
    created_at: number
    message_count: number
    last_message_at: number
  }[]

  const threads = rows.map((r) => ({
    id: r.id,
    channel_id: r.channel_id,
    name: r.name,
    creator_id: r.creator_id,
    created_at: r.created_at * 1000,
    message_count: r.message_count,
    last_message_at: r.last_message_at * 1000,
  }))

  return c.json({ threads })
})

threadsRoutes.post('/:channelId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const db = getDb()

  if (!parentChannelVisible(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }

  let body: { name?: string; message_id?: string } | undefined
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const name = (typeof body?.name === 'string' && body.name.trim()) || 'Thread'
  const trimmedName = name.slice(0, 100)
  const messageId = typeof body?.message_id === 'string' ? body.message_id : undefined

  const denied = checkCanPost(c, user.userId, channelId, trimmedName)
  if (denied) return denied

  if (messageId) {
    const starter = db
      .prepare('SELECT thread_id FROM messages WHERE id = ? AND channel_id = ?')
      .get(messageId, channelId) as { thread_id: string | null } | undefined
    if (!starter) return c.json({ error: 'Message not found' }, 404)
    if (starter.thread_id) return c.json({ error: 'Message already has a thread' }, 409)
  }

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    db.prepare(
      'INSERT INTO threads (id, channel_id, name, creator_id, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, channelId, trimmedName, user.userId, now, now)

    if (messageId) {
      db.prepare(
        'UPDATE messages SET thread_id = ? WHERE id = ? AND channel_id = ? AND thread_id IS NULL',
      ).run(id, messageId, channelId)
      db.prepare('UPDATE threads SET message_count = message_count + 1 WHERE id = ?').run(id)
    }
  })()

  const io = getIo(c)
  if (io) {
    io.to(channelId).emit('thread:created', {
      id,
      channel_id: channelId,
      name: trimmedName,
      creator_id: user.userId,
      created_at: now * 1000,
      message_count: messageId ? 2 : 1,
      last_message_at: now * 1000,
    })
  }

  return c.json({ success: true, id })
})

threadsRoutes.delete('/:channelId/:threadId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const threadId = c.req.param('threadId')!
  const db = getDb()

  if (!parentChannelVisible(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }

  const thread = db
    .prepare('SELECT * FROM threads WHERE id = ? AND channel_id = ?')
    .get(threadId, channelId) as { creator_id: string; created_at: number } | undefined

  if (!thread) return c.json({ error: 'Thread not found' }, 404)

  const userPerms = getUserPermissions(user.userId)
  if (thread.creator_id !== user.userId) {
    if (!userPerms || !hasPermission(userPerms, 'delete_messages')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  // The channel message a thread was started from carries the thread's id too,
  // but it belongs to the channel, not the thread: detach it and keep it. It is
  // the oldest tagged message and predates the thread row (there's no starter
  // column, so this is inferred). Only the thread's own replies are deleted.
  const attachmentUrls = db.transaction(() => {
    db.prepare(
      `UPDATE messages SET thread_id = NULL
       WHERE rowid = (SELECT rowid FROM messages WHERE thread_id = ? ORDER BY rowid ASC LIMIT 1)
         AND created_at <= ?`,
    ).run(threadId, thread.created_at)

    const replies = db.prepare('SELECT id FROM messages WHERE thread_id = ?').all(threadId) as {
      id: string
    }[]
    const urls: string[] = []
    for (const reply of replies) urls.push(...deleteMessageRows(reply.id))
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
    return urls
  })()

  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  await Promise.all(
    attachmentUrls.map(async (url) => {
      try {
        await fs.unlink(path.join(uploadsDir, path.basename(url)))
      } catch {
        /* file may not exist */
      }
    }),
  )

  emitToRoom(c, channelId, 'thread:deleted', { id: threadId, channel_id: channelId } as never)

  return c.json({ ok: true })
})

threadsRoutes.get('/:channelId/:threadId/messages', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const threadId = c.req.param('threadId')!
  const limit = parseLimit(c.req.query('limit'))
  const before = c.req.query('before')

  if (!parentChannelVisible(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }

  const db = getDb()
  const thread = db
    .prepare('SELECT 1 FROM threads WHERE id = ? AND channel_id = ?')
    .get(threadId, channelId)
  if (!thread) return c.json({ error: 'Thread not found' }, 404)
  let rows: {
    id: string
    channel_id: string
    author_id: string
    author_username: string
    display_name: string | null
    avatar: string | null
    content: string
    created_at: number
    edited_at: number | null
    reply_to_message_id: string | null
    reply_to_username: string | null
    reply_to_content: string | null
    thread_id: string | null
  }[]
  if (before) {
    rows = db
      .prepare(
        `SELECT m.*, u.display_name, u.avatar FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.thread_id = ? AND m.rowid < (SELECT rowid FROM messages WHERE id = ? AND thread_id = ?)
       ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(threadId, before, threadId, limit) as typeof rows
  } else {
    rows = db
      .prepare(
        `SELECT m.*, u.display_name, u.avatar FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.thread_id = ?
       ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(threadId, limit) as typeof rows
  }

  const messages = rows.reverse().map((r) => ({
    id: r.id,
    channel_id: r.channel_id,
    user_id: r.author_id,
    username: r.author_username,
    display_name: r.display_name || r.author_username,
    avatar: r.avatar || undefined,
    content: r.content,
    created_at: r.created_at * 1000,
    edited_at: r.edited_at ? r.edited_at * 1000 : null,
    reply_to_message_id: r.reply_to_message_id || null,
    reply_to_username: r.reply_to_username || null,
    reply_to_content: r.reply_to_content || null,
    thread_id: r.thread_id || null,
  }))

  const hasMore = messages.length >= limit

  return c.json({ messages, hasMore })
})

threadsRoutes.post('/:channelId/:threadId/messages', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const threadId = c.req.param('threadId')!

  let body: { content?: string } | undefined
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const content = typeof body?.content === 'string' ? body.content.trim() : ''
  if (!content) return c.json({ error: 'Content required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Content too long' }, 400)

  if (!parentChannelVisible(user.userId, channelId)) {
    return c.json({ error: 'Channel not found' }, 404)
  }

  const db = getDb()
  const thread = db
    .prepare('SELECT id FROM threads WHERE id = ? AND channel_id = ?')
    .get(threadId, channelId)
  if (!thread) return c.json({ error: 'Thread not found' }, 404)

  const denied = checkCanPost(c, user.userId, channelId, content)
  if (denied) return denied

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO messages (id, channel_id, author_id, author_username, content, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channelId, user.userId, user.username, content, threadId, now, now)

  db.prepare(
    'UPDATE threads SET message_count = message_count + 1, last_message_at = ? WHERE id = ?',
  ).run(now, threadId)

  const message = {
    id,
    channel_id: channelId,
    user_id: user.userId,
    username: user.username,
    display_name: user.username,
    content,
    created_at: now * 1000,
    thread_id: threadId,
  }

  const io = getIo(c)
  if (io) {
    io.to(threadId).emit('thread:message:new', message as never)
  }

  return c.json({ message })
})

export default threadsRoutes
export { threadsRoutes }
