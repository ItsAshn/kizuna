import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import { getUserPermissions, hasPermission, canWriteToChannel, isUserAdmin } from '../../middleware/auth'
import path from 'node:path'
import fs from 'node:fs'
import { checkSpam } from '../../services/spamFilter'
import { checkMessageContent } from '../../moderation'
import { prep, checkSocketRateLimit, type MessageRow } from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'
import { parseMentions, processMentions } from './mentions'

export function registerChannelMessageHandlers(io: Server, socket: Socket): void {
  const NOTIFICATION_ROOM = '__notifications__'
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('message:send', ({ channelId, content, replyToMessageId }: {
    channelId: string
    content: string
    replyToMessageId?: string
  }) => {
    if (!checkSocketRateLimit(socket, 'message:send', 30, 10_000)) return
    if (!channelId || !content?.trim() || !userId) return
    if (content.length > 4000) return

    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'send_messages')) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'You do not have permission to send messages' })
      return
    }

    if (!canWriteToChannel(userId, channelId)) {
      socket.emit('error', { code: 'LOCKED', message: 'This channel is locked — only admins can send messages' })
      return
    }

    if (!isUserAdmin(userId)) {
      const spamResult = checkSpam(userId, channelId, content)
      if (!spamResult.allowed) {
        return
      }
    }

    if (!checkMessageContent(content.trim()).allowed) {
      socket.emit('error', { code: 'BLOCKED', message: 'Message contains blocked content' })
      return
    }

    const db = getDb()
    const id = uuidv4()
    let replyUsername: string | null = null
    let replyContent: string | null = null
    if (replyToMessageId) {
      const replyMsg = db.prepare('SELECT author_username, content FROM messages WHERE id = ? AND channel_id = ?').get(replyToMessageId, channelId) as { author_username: string; content: string } | undefined
      if (replyMsg) {
        replyUsername = replyMsg.author_username
        replyContent = replyMsg.content
      }
    }
    db.prepare(
      `INSERT INTO messages (id, channel_id, author_id, author_username, content, reply_to_message_id, reply_to_username, reply_to_content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, channelId, userId, username, content.trim(), replyToMessageId || null, replyUsername, replyContent)

    const row = db.prepare(
      `SELECT m.*, u.display_name, u.avatar
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.id = ?`
    ).get(id) as MessageRow

    const message = {
      id: row.id,
      channel_id: row.channel_id,
      user_id: row.author_id,
      username: row.author_username,
      display_name: row.display_name || row.author_username,
      avatar: row.avatar || undefined,
      content: row.content,
      created_at: row.created_at * 1000,
      reply_to_message_id: row.reply_to_message_id || null,
      reply_to_username: row.reply_to_username || null,
      reply_to_content: row.reply_to_content || null,
    }

    io.to(channelId).to(NOTIFICATION_ROOM).emit('message:new', message)

    const mentions = parseMentions(content.trim())
    processMentions(io, { ...message, author_id: row.author_id, author_username: row.author_username }, mentions)
  })

  socket.on('message:edit', ({ messageId, content }: {
    messageId: string
    content: string
  }) => {
    if (!checkSocketRateLimit(socket, 'message:edit', 20, 10_000)) return
    if (!messageId || !content?.trim() || !userId) return
    if (content.length > 4000) return

    if (!checkMessageContent(content.trim()).allowed) {
      socket.emit('error', { code: 'BLOCKED', message: 'Message contains blocked content' })
      return
    }

    const db = getDb()
    const existing = db.prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?').get(messageId, userId) as { channel_id: string; content: string } | undefined
    if (!existing) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuidv4(), messageId, existing.content, userId, now)
    db.prepare('UPDATE messages SET content = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(
      content.trim(), now, now, messageId,
    )

    const row = db.prepare(
      `SELECT m.*, u.display_name, u.avatar
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.id = ?`
    ).get(messageId) as MessageRow

    const updated = {
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

    io.to(existing.channel_id).to(NOTIFICATION_ROOM).emit('message:edit', updated)
  })

  socket.on('message:delete', ({ messageId }: { messageId: string }) => {
    if (!userId) return
    const db = getDb()
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as { channel_id: string; author_id: string } | undefined
    if (!message) return

    const userPerms = getUserPermissions(userId)
    if (message.author_id !== userId && (!userPerms || !hasPermission(userPerms, 'delete_messages'))) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot delete this message' })
      return
    }

    const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId) as { url: string }[]
    for (const att of attachments) {
      const filepath = path.join(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'), path.basename(att.url))
      try { fs.unlinkSync(filepath) } catch { }
    }
    db.prepare('DELETE FROM mentions WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    io.to(message.channel_id).to(NOTIFICATION_ROOM).emit('message:delete', { id: messageId, channel_id: message.channel_id })
  })

  socket.on('mentions:read', ({ channelId }: { channelId?: string }) => {
    if (!userId) return
    if (channelId) {
      prep(
        `UPDATE mentions SET read = 1
         WHERE (mentioned_user_id = ? OR mention_type IN ('everyone', 'here'))
           AND channel_id = ? AND read = 0`
      ).run(userId, channelId)
    } else {
      prep(
        `UPDATE mentions SET read = 1
         WHERE (mentioned_user_id = ? OR mention_type IN ('everyone', 'here')) AND read = 0`
      ).run(userId)
    }
  })

  socket.on('channel:read', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId || !channelId) return
    const now = Math.floor(Date.now() / 1000)
    prep(
      `INSERT INTO channel_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(userId, channelId, now)

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })

  socket.on('channel:unread', (_, callback?: Function) => {
    if (!userId || typeof callback !== 'function') return
    const db = getDb()
    const countRows = db.prepare(`
      SELECT m.channel_id, COUNT(*) as count
      FROM messages m
      JOIN channels c ON c.id = m.channel_id AND c.type = 'text'
      LEFT JOIN channel_reads cr ON cr.channel_id = m.channel_id AND cr.user_id = ?
      WHERE m.created_at > COALESCE(cr.last_read_at, 0)
      GROUP BY m.channel_id
    `).all(userId) as { channel_id: string; count: number }[]

    const unreadCounts: Record<string, number> = {}
    for (const row of countRows) {
      unreadCounts[row.channel_id] = row.count
    }

    callback(unreadCounts)
  })

  socket.on('mentions:unread', (_, callback?: Function) => {
    if (!userId || typeof callback !== 'function') return
    const db = getDb()
    const rows = db.prepare(
      `SELECT channel_id, COUNT(*) as count FROM mentions
       WHERE (mentioned_user_id = ? OR mention_type IN ('everyone', 'here')) AND read = 0
       GROUP BY channel_id`
    ).all(userId)
    callback(rows)
  })

  socket.on('typing:start', ({ channelId }: { channelId: string }) => {
    if (!checkSocketRateLimit(socket, 'typing', 20, 10_000)) return
    socket.to(channelId).emit('typing:start', { channelId, username })
  })

  socket.on('typing:stop', ({ channelId }: { channelId: string }) => {
    socket.to(channelId).emit('typing:stop', { channelId, username })
  })
}
