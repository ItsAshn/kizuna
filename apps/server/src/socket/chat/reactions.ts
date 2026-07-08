import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import { getUserPermissions, hasPermission } from '../../middleware/auth'
import { checkSocketRateLimit } from './infra'
import { getSocketUserId, getSocketUsername, getMessageInfo, broadcastReaction } from './helpers'

export function registerReactionHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('message:react', ({ messageId, reactionKey, reactionType }: { messageId: string; reactionKey: string; reactionType?: string }) => {
    if (!userId || !username) return
    if (!checkSocketRateLimit(socket, 'react', 20, 10000)) return

    const db = getDb()
    const msgInfo = getMessageInfo(db, messageId)
    if (!msgInfo) return

    if (!msgInfo.isDM) {
      const perms = getUserPermissions(userId)
      if (!perms || !hasPermission(perms, 'add_reactions')) return
    }

    const existing = db.prepare(
      'SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_key = ?'
    ).get(messageId, userId, reactionKey)

    if (existing) return

    const type = reactionType || 'emoji'
    db.prepare(
      'INSERT INTO message_reactions (message_id, user_id, reaction_key, reaction_type) VALUES (?, ?, ?, ?)'
    ).run(messageId, userId, reactionKey, type)

    broadcastReaction(io, msgInfo, 'message:react:add', {
      messageId,
      channelId: msgInfo.channel_id,
      reaction: { reaction_key: reactionKey, reaction_type: type, userId, username },
    })
  })

  socket.on('message:unreact', ({ messageId, reactionKey }: { messageId: string; reactionKey: string }) => {
    if (!userId) return

    const db = getDb()
    const msgInfo = getMessageInfo(db, messageId)
    if (!msgInfo) return

    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_key = ?')
      .run(messageId, userId, reactionKey)

    broadcastReaction(io, msgInfo, 'message:react:remove', {
      messageId,
      channelId: msgInfo.channel_id,
      reactionKey,
      userId,
    })
  })

  // ─── Pins ───────────────────────────────────────────

  socket.on('message:pin', ({ channelId, messageId }: { channelId: string; messageId: string }) => {
    if (!userId || !username) return
    if (!checkSocketRateLimit(socket, 'pin', 10, 10_000)) return

    const db = getDb()
    const existing = db.prepare('SELECT id FROM pinned_messages WHERE channel_id = ? AND message_id = ?').get(channelId, messageId)
    if (existing) return

    const count = db.prepare('SELECT COUNT(*) as count FROM pinned_messages WHERE channel_id = ?').get(channelId) as { count: number }
    if (count.count >= 50) return

    const pinId = uuidv4()
    db.prepare('INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)').run(pinId, channelId, messageId, userId)

    const msg = db.prepare('SELECT content, author_id, author_username FROM messages WHERE id = ?').get(messageId) as { content: string; author_id: string; author_username: string } | undefined
    const pin = {
      id: pinId,
      messageId,
      channelId,
      pinnedBy: userId,
      pinnedByUsername: username,
      pinnedAt: Date.now(),
      content: msg?.content || '',
      authorId: msg?.author_id || '',
      authorUsername: msg?.author_username || '',
    }

    io.to(channelId).emit('message:pin', pin)
  })

  socket.on('message:unpin', ({ channelId, messageId }: { channelId: string; messageId: string }) => {
    if (!userId) return

    const db = getDb()
    db.prepare('DELETE FROM pinned_messages WHERE channel_id = ? AND message_id = ?').run(channelId, messageId)

    io.to(channelId).emit('message:unpin', { channelId, messageId })
  })

  // ─── Threads ────────────────────────────────────────
}
