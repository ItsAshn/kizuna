import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission } from '../middleware/auth'
import type { Context } from 'hono'
import type { AuthUser } from '../types'
import type { Server as IoServer } from 'socket.io'

function getAuth(c: Context): AuthUser { return c.get('auth') }

const threadsRoutes = new Hono()

threadsRoutes.get('/:channelId', authMiddleware, (c) => {
  const channelId = c.req.param('channelId')
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM threads WHERE channel_id = ? ORDER BY last_message_at DESC'
  ).all(channelId) as {
    id: string; channel_id: string; name: string; creator_id: string;
    created_at: number; message_count: number; last_message_at: number
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

  let body: { name?: string; message_id?: string } | undefined
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const name = (body?.name || 'Thread').slice(0, 100)
  const messageId = body?.message_id

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO threads (id, channel_id, name, creator_id, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, name.slice(0, 100), user.userId, now, now)

  if (messageId) {
    db.prepare('UPDATE messages SET thread_id = ? WHERE id = ? AND channel_id = ?').run(id, messageId, channelId)
    db.prepare('UPDATE threads SET message_count = message_count + 1 WHERE id = ?').run(id)
  }

  const io = c.get('io' as never) as IoServer | undefined
  if (io) {
    io.to(channelId).emit('thread:created', {
      id,
      channel_id: channelId,
      name,
      creator_id: user.userId,
      created_at: now * 1000,
      message_count: messageId ? 2 : 1,
      last_message_at: now * 1000,
    })
  }

  return c.json({ success: true, id })
})

threadsRoutes.delete('/:channelId/:threadId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const threadId = c.req.param('threadId')!
  const db = getDb()

  const thread = db.prepare(
    'SELECT * FROM threads WHERE id = ? AND channel_id = ?'
  ).get(threadId, channelId) as { creator_id: string } | undefined

  if (!thread) return c.json({ error: 'Thread not found' }, 404)

  const userPerms = getUserPermissions(user.userId)
  if (thread.creator_id !== user.userId) {
    if (!userPerms || !hasPermission(userPerms, 'delete_messages')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)

  try {
    const io = c.get('io' as never) as IoServer | undefined
    if (io) {
      io.to(channelId).emit('thread:deleted', { id: threadId, channel_id: channelId } as never)
    }
  } catch { /* best-effort */ }

  return c.json({ ok: true })
})

threadsRoutes.get('/:channelId/:threadId/messages', authMiddleware, (c) => {
  const threadId = c.req.param('threadId')
  const limit = parseInt(c.req.query('limit') || '50', 10)
  const before = c.req.query('before')

  const db = getDb()
  let rows: {
    id: string; channel_id: string; author_id: string; author_username: string;
    display_name: string | null; avatar: string | null; content: string;
    created_at: number; edited_at: number | null;
    reply_to_message_id: string | null; reply_to_username: string | null;
    reply_to_content: string | null; thread_id: string | null
  }[]
  if (before) {
    rows = db.prepare(
      `SELECT m.*, u.display_name, u.avatar FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.thread_id = ? AND m.rowid < (SELECT rowid FROM messages WHERE id = ?)
       ORDER BY m.created_at DESC LIMIT ?`
    ).all(threadId, before, limit) as typeof rows
  } else {
    rows = db.prepare(
      `SELECT m.*, u.display_name, u.avatar FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.thread_id = ?
       ORDER BY m.created_at DESC LIMIT ?`
    ).all(threadId, limit) as typeof rows
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
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const content = body?.content?.trim()
  if (!content) return c.json({ error: 'Content required' }, 400)
  if (content.length > 4000) return c.json({ error: 'Content too long' }, 400)

  const db = getDb()
  const thread = db.prepare('SELECT id FROM threads WHERE id = ? AND channel_id = ?').get(threadId, channelId)
  if (!thread) return c.json({ error: 'Thread not found' }, 404)

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO messages (id, channel_id, author_id, author_username, content, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, channelId, user.userId, user.username, content, threadId, now, now)

  db.prepare(
    'UPDATE threads SET message_count = message_count + 1, last_message_at = ? WHERE id = ?'
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

  const io = c.get('io' as never) as IoServer | undefined
  if (io) {
    io.to(threadId).emit('thread:message:new', message as never)
  }

  return c.json({ message })
})

export default threadsRoutes
export { threadsRoutes }
