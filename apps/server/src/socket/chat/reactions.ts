import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import {
  canViewChannel,
  canWriteToChannel,
  getUserChannelPermission,
  getUserPermissions,
  hasPermission,
} from '../../middleware/auth'
import { checkSocketRateLimit } from './infra'
import {
  getSocketUserId,
  getSocketUsername,
  getMessageInfo,
  broadcastReaction,
  canAccessMessage,
} from './helpers'
import { isRecord, isId } from '../validate'

const MAX_REACTION_KEY = 128
const MAX_REACTION_TYPE = 32

export function registerReactionHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('message:react', (payload: unknown) => {
    if (!userId || !username) return
    if (!checkSocketRateLimit(socket, 'react', 20, 10000)) return
    if (!isRecord(payload)) return
    const { messageId, reactionKey, reactionType } = payload
    if (!isId(messageId) || !isId(reactionKey, MAX_REACTION_KEY)) return
    if (
      reactionType !== undefined &&
      reactionType !== null &&
      !isId(reactionType, MAX_REACTION_TYPE)
    )
      return

    const db = getDb()
    const msgInfo = getMessageInfo(db, messageId)
    if (!msgInfo || !canAccessMessage(userId, msgInfo)) return

    if (msgInfo.isGroupDM) {
      const perms = getUserPermissions(userId)
      if (!perms || !hasPermission(perms, 'add_reactions')) return
    } else if (!msgInfo.isDM) {
      // Channel-level resolution so role overrides that deny add_reactions
      // in this channel are honoured.
      if (!getUserChannelPermission(userId, msgInfo.channel_id, 'add_reactions')) return
    }

    const existing = db
      .prepare(
        'SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_key = ?',
      )
      .get(messageId, userId, reactionKey)

    if (existing) return

    const type = (reactionType as string | null | undefined) || 'emoji'
    db.prepare(
      'INSERT INTO message_reactions (message_id, user_id, reaction_key, reaction_type) VALUES (?, ?, ?, ?)',
    ).run(messageId, userId, reactionKey, type)

    broadcastReaction(io, msgInfo, 'message:react:add', {
      messageId,
      channelId: msgInfo.channel_id,
      reaction: { reaction_key: reactionKey, reaction_type: type, userId, username },
    })
  })

  socket.on('message:unreact', (payload: unknown) => {
    if (!userId || !isRecord(payload)) return
    if (!checkSocketRateLimit(socket, 'react', 20, 10000)) return
    const { messageId, reactionKey } = payload
    if (!isId(messageId) || !isId(reactionKey, MAX_REACTION_KEY)) return

    const db = getDb()
    const msgInfo = getMessageInfo(db, messageId)
    if (!msgInfo || !canAccessMessage(userId, msgInfo)) return

    const result = db
      .prepare(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction_key = ?',
      )
      .run(messageId, userId, reactionKey)
    if (result.changes === 0) return

    broadcastReaction(io, msgInfo, 'message:react:remove', {
      messageId,
      channelId: msgInfo.channel_id,
      reactionKey,
      userId,
    })
  })

  // ─── Pins ───────────────────────────────────────────

  // There is no manage_messages permission in this codebase; delete_messages
  // (resolved with channel overrides) is the moderator permission, and a
  // message's author may also pin/unpin their own message.
  const canManagePin = (channelId: string, authorId: string): boolean =>
    authorId === userId || getUserChannelPermission(userId, channelId, 'delete_messages')

  const loadPinTarget = (
    payload: unknown,
  ): {
    channelId: string
    messageId: string
    msg: { content: string; author_id: string; author_username: string }
  } | null => {
    if (!isRecord(payload)) return null
    const { channelId, messageId } = payload
    if (!isId(channelId) || !isId(messageId)) return null
    const msg = getDb()
      .prepare('SELECT channel_id, content, author_id, author_username FROM messages WHERE id = ?')
      .get(messageId) as
      | { channel_id: string; content: string; author_id: string; author_username: string }
      | undefined
    if (!msg || msg.channel_id !== channelId) return null
    if (!canViewChannel(userId, channelId) || !canWriteToChannel(userId, channelId)) return null
    if (!canManagePin(channelId, msg.author_id)) return null
    return { channelId, messageId, msg }
  }

  socket.on('message:pin', (payload: unknown) => {
    if (!userId || !username) return
    if (!checkSocketRateLimit(socket, 'pin', 10, 10_000)) return
    const target = loadPinTarget(payload)
    if (!target) return
    const { channelId, messageId, msg } = target

    const db = getDb()
    const existing = db
      .prepare('SELECT id FROM pinned_messages WHERE channel_id = ? AND message_id = ?')
      .get(channelId, messageId)
    if (existing) return

    const count = db
      .prepare('SELECT COUNT(*) as count FROM pinned_messages WHERE channel_id = ?')
      .get(channelId) as { count: number }
    if (count.count >= 50) return

    const pinId = uuidv4()
    db.prepare(
      'INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)',
    ).run(pinId, channelId, messageId, userId)

    const pin = {
      id: pinId,
      messageId,
      channelId,
      pinnedBy: userId,
      pinnedByUsername: username,
      pinnedAt: Date.now(),
      content: msg.content,
      authorId: msg.author_id,
      authorUsername: msg.author_username,
    }

    io.to(channelId).emit('message:pin', pin)
  })

  socket.on('message:unpin', (payload: unknown) => {
    if (!userId) return
    if (!checkSocketRateLimit(socket, 'pin', 10, 10_000)) return
    const target = loadPinTarget(payload)
    if (!target) return
    const { channelId, messageId } = target

    const result = getDb()
      .prepare('DELETE FROM pinned_messages WHERE channel_id = ? AND message_id = ?')
      .run(channelId, messageId)
    if (result.changes === 0) return

    io.to(channelId).emit('message:unpin', { channelId, messageId })
  })

  // ─── Threads ────────────────────────────────────────
}
