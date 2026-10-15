import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import {
  canViewChannel,
  canWriteToChannel,
  getUserChannelPermission,
  isUserAdmin,
  getEligibleNotifyUserIds,
} from '../../middleware/auth'
import path from 'node:path'
import fs from 'node:fs'
import { checkSpam } from '../../services/spamFilter'
import { checkMessageContent } from '../../moderation'
import { prep, checkSocketRateLimit, type MessageRow } from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'
import { isRecord, isId, isText, optionalId, isReservedRoom } from '../validate'
import { parseMentions, processMentions } from './mentions'
import { dispatchOutgoing } from '../../services/outgoingWebhooks'
import { deleteMessageRows } from '../../services/messageDeletion'

// Channels the user has never opened have no channel_reads row. Counting
// "everything since the dawn of time" for those scanned the full history of
// every channel on each call, so the unread window for them starts at the
// later of the user's server join time and this cap.
const UNREAD_FALLBACK_WINDOW_SECONDS = 30 * 24 * 60 * 60

const MAX_MESSAGE_LENGTH = 4000

export function registerChannelMessageHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('message:send', (payload: unknown) => {
    if (!checkSocketRateLimit(socket, 'message:send', 30, 10_000)) return
    if (!userId || !isRecord(payload)) return
    const { channelId, content, replyToMessageId } = payload
    if (!isId(channelId) || !isText(content, MAX_MESSAGE_LENGTH)) return
    if (!optionalId(replyToMessageId)) return

    const channel = getDb().prepare('SELECT type FROM channels WHERE id = ?').get(channelId) as
      | { type: string }
      | undefined
    if (!channel || channel.type !== 'text' || !canViewChannel(userId, channelId)) {
      socket.emit('error', { code: 'NOT_FOUND', message: 'Channel not found' })
      return
    }

    // Channel-level resolution so role overrides that deny send_messages in
    // this channel are honoured, not just the server-wide base permission.
    if (!getUserChannelPermission(userId, channelId, 'send_messages')) {
      socket.emit('error', {
        code: 'FORBIDDEN',
        message: 'You do not have permission to send messages',
      })
      return
    }

    if (!canWriteToChannel(userId, channelId)) {
      socket.emit('error', {
        code: 'LOCKED',
        message: 'This channel is locked — only admins can send messages',
      })
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
      const replyMsg = db
        .prepare('SELECT author_username, content FROM messages WHERE id = ? AND channel_id = ?')
        .get(replyToMessageId, channelId) as
        | { author_username: string; content: string }
        | undefined
      if (replyMsg) {
        replyUsername = replyMsg.author_username
        replyContent = replyMsg.content
      }
    }
    db.prepare(
      `INSERT INTO messages (id, channel_id, author_id, author_username, content, reply_to_message_id, reply_to_username, reply_to_content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      channelId,
      userId,
      username,
      content.trim(),
      replyToMessageId || null,
      replyUsername,
      replyContent,
    )

    const row = db
      .prepare(
        `SELECT m.*, u.display_name, u.avatar
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.id = ?`,
      )
      .get(id) as MessageRow

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

    io.to(channelId).emit('message:new', message)
    for (const uid of getEligibleNotifyUserIds(channelId, userId)) {
      io.to(`user:${uid}`).emit('message:new', message)
    }
    dispatchOutgoing(
      'message.created',
      {
        channel: { id: channelId },
        user: { id: userId, username },
        message: { id, content: content.trim() },
      },
      { channelId },
    )

    const mentions = parseMentions(content.trim())
    processMentions(
      io,
      { ...message, author_id: row.author_id, author_username: row.author_username },
      mentions,
    )
  })

  socket.on('message:edit', (payload: unknown) => {
    if (!checkSocketRateLimit(socket, 'message:edit', 20, 10_000)) return
    if (!userId || !isRecord(payload)) return
    const { messageId, content } = payload
    if (!isId(messageId) || !isText(content, MAX_MESSAGE_LENGTH)) return

    if (!checkMessageContent(content.trim()).allowed) {
      socket.emit('error', { code: 'BLOCKED', message: 'Message contains blocked content' })
      return
    }

    const db = getDb()
    const existing = db
      .prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?')
      .get(messageId, userId) as { channel_id: string; content: string } | undefined
    if (!existing) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)',
    ).run(uuidv4(), messageId, existing.content, userId, now)
    db.prepare('UPDATE messages SET content = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(
      content.trim(),
      now,
      now,
      messageId,
    )

    const row = db
      .prepare(
        `SELECT m.*, u.display_name, u.avatar
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.id = ?`,
      )
      .get(messageId) as MessageRow

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

    io.to(existing.channel_id).emit('message:edit', updated)
    for (const uid of getEligibleNotifyUserIds(existing.channel_id, userId)) {
      io.to(`user:${uid}`).emit('message:edit', updated)
    }
    dispatchOutgoing(
      'message.updated',
      {
        channel: { id: existing.channel_id },
        user: { id: userId, username },
        message: { id: messageId, content: content.trim() },
      },
      { channelId: existing.channel_id },
    )
  })

  socket.on('message:delete', (payload: unknown) => {
    if (!userId || !isRecord(payload)) return
    const { messageId } = payload
    if (!isId(messageId)) return
    const db = getDb()
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | { channel_id: string; author_id: string }
      | undefined
    if (!message) return

    if (
      message.author_id !== userId &&
      !getUserChannelPermission(userId, message.channel_id, 'delete_messages')
    ) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot delete this message' })
      return
    }

    const attachmentUrls = deleteMessageRows(messageId)
    for (const url of attachmentUrls) {
      const filepath = path.join(
        process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'),
        path.basename(url),
      )
      try {
        fs.unlinkSync(filepath)
      } catch {}
    }
    io.to(message.channel_id).emit('message:delete', {
      id: messageId,
      channel_id: message.channel_id,
    })
    for (const uid of getEligibleNotifyUserIds(message.channel_id, userId)) {
      io.to(`user:${uid}`).emit('message:delete', { id: messageId, channel_id: message.channel_id })
    }
    dispatchOutgoing(
      'message.deleted',
      {
        channel: { id: message.channel_id },
        user: { id: userId, username },
        message: { id: messageId },
      },
      { channelId: message.channel_id },
    )
  })

  // Direct (user/role) mentions are one row per recipient and keep using the
  // row's `read` flag. @everyone/@here rows are shared by every member, so
  // their read state lives per user in mention_reads — otherwise the first
  // member to open the channel cleared it for everybody.
  socket.on('mentions:read', (payload: unknown) => {
    if (!userId) return
    const channelId = isRecord(payload) ? payload.channelId : undefined
    if (!optionalId(channelId)) return
    if (channelId) {
      prep(
        `UPDATE mentions SET read = 1
         WHERE mentioned_user_id = ? AND channel_id = ? AND read = 0`,
      ).run(userId, channelId)
      prep(
        `INSERT OR IGNORE INTO mention_reads (mention_id, user_id)
         SELECT id, ? FROM mentions
         WHERE mention_type IN ('everyone', 'here') AND channel_id = ?`,
      ).run(userId, channelId)
    } else {
      prep(`UPDATE mentions SET read = 1 WHERE mentioned_user_id = ? AND read = 0`).run(userId)
      prep(
        `INSERT OR IGNORE INTO mention_reads (mention_id, user_id)
         SELECT id, ? FROM mentions WHERE mention_type IN ('everyone', 'here')`,
      ).run(userId)
    }
  })

  socket.on('channel:read', (payload: unknown, callback?: unknown) => {
    if (!userId || !isRecord(payload)) return
    const { channelId } = payload
    if (!isId(channelId)) return
    const channel = prep('SELECT 1 FROM channels WHERE id = ?').get(channelId)
    if (!channel || !canViewChannel(userId, channelId)) {
      if (typeof callback === 'function') callback({ error: 'Channel not found' })
      return
    }
    const now = Math.floor(Date.now() / 1000)
    prep(
      `INSERT INTO channel_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    ).run(userId, channelId, now)

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })

  socket.on('channel:unread', (...args: unknown[]) => {
    const callback = args[args.length - 1]
    if (!userId || typeof callback !== 'function') return
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const member = db
      .prepare('SELECT joined_at FROM server_members WHERE user_id = ?')
      .get(userId) as { joined_at: number | null } | undefined
    const floor = Math.max(member?.joined_at ?? 0, now - UNREAD_FALLBACK_WINDOW_SECONDS)

    // Driven from channels so each count is an index range scan on
    // (channel_id, created_at) rather than a GROUP BY over all messages.
    const countRows = db
      .prepare(
        `
      SELECT c.id AS channel_id,
        (SELECT COUNT(*) FROM messages m
          WHERE m.channel_id = c.id AND m.created_at > COALESCE(cr.last_read_at, ?)) AS count
      FROM channels c
      LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = ?
      WHERE c.type = 'text'
    `,
      )
      .all(floor, userId) as { channel_id: string; count: number }[]

    const unreadCounts: Record<string, number> = {}
    for (const row of countRows) {
      if (row.count > 0 && canViewChannel(userId, row.channel_id)) {
        unreadCounts[row.channel_id] = row.count
      }
    }

    callback(unreadCounts)
  })

  socket.on('mentions:unread', (...args: unknown[]) => {
    const callback = args[args.length - 1]
    if (!userId || typeof callback !== 'function') return
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT m.channel_id, COUNT(*) as count FROM mentions m
       WHERE (
         (m.mentioned_user_id = ? AND m.read = 0)
         OR (
           m.mention_type IN ('everyone', 'here')
           AND m.author_id != ?
           AND m.created_at >= COALESCE((SELECT joined_at FROM server_members WHERE user_id = ?), 0)
           AND NOT EXISTS (
             SELECT 1 FROM mention_reads mr WHERE mr.mention_id = m.id AND mr.user_id = ?
           )
         )
       )
       GROUP BY m.channel_id`,
      )
      .all(userId, userId, userId, userId) as { channel_id: string; count: number }[]
    callback(rows.filter((r) => canViewChannel(userId, r.channel_id)))
  })

  // Only relay to rooms this socket was admitted to by channel:join, never to
  // personal user:/dm:/group-dm: rooms.
  const canRelayTyping = (payload: unknown): payload is { channelId: string } =>
    isRecord(payload) &&
    isId(payload.channelId) &&
    !isReservedRoom(payload.channelId) &&
    socket.rooms.has(payload.channelId)

  socket.on('typing:start', (payload: unknown) => {
    if (!checkSocketRateLimit(socket, 'typing', 20, 10_000)) return
    if (!canRelayTyping(payload)) return
    socket.to(payload.channelId).emit('typing:start', { channelId: payload.channelId, username })
  })

  socket.on('typing:stop', (payload: unknown) => {
    if (!checkSocketRateLimit(socket, 'typing', 20, 10_000)) return
    if (!canRelayTyping(payload)) return
    socket.to(payload.channelId).emit('typing:stop', { channelId: payload.channelId, username })
  })
}
