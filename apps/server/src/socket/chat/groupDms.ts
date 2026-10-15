import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import { getUserPermissions, hasPermission } from '../../middleware/auth'
import { prep, checkSocketRateLimit } from './infra'
import { getSocketUserId, getSocketUsername, isGroupDmMember } from './helpers'
import { isRecord, isId, isText } from '../validate'

// Same limits as the REST group DM routes; ciphertext is larger than plaintext.
const maxGroupDmLength = (encrypted: boolean): number => (encrypted ? 8000 : 4000)

export function registerGroupDmHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('group-dm:send', (payload: unknown) => {
    if (!checkSocketRateLimit(socket, 'dm:send', 30, 10_000)) return
    if (!userId || !isRecord(payload)) return
    const { channelId, content } = payload
    const encrypted = payload.encrypted === true
    if (!isId(channelId) || !isText(content, maxGroupDmLength(encrypted))) return

    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'send_dm_messages')) {
      socket.emit('error', {
        code: 'FORBIDDEN',
        message: 'You do not have permission to send direct messages',
      })
      return
    }

    const db = getDb()
    if (!isGroupDmMember(userId, channelId)) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Not a member of this group' })
      return
    }

    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO group_dm_messages (id, channel_id, from_id, from_username, content, encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, channelId, userId, username, content.trim(), encrypted ? 1 : 0, now)

    db.prepare('UPDATE group_dm_channels SET last_message_at = ? WHERE id = ?').run(now, channelId)

    const userRow = db
      .prepare('SELECT display_name, avatar FROM users WHERE id = ?')
      .get(userId) as { display_name: string | null; avatar: string | null } | undefined
    const message = {
      id,
      channel_id: channelId,
      user_id: userId,
      username,
      display_name: userRow?.display_name || username,
      avatar: userRow?.avatar || undefined,
      content: content.trim(),
      encrypted: encrypted ? 1 : 0,
      created_at: now * 1000,
    }

    const members = db
      .prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ? AND user_id != ?')
      .all(channelId, userId) as { user_id: string }[]

    for (const m of members) {
      io.to(`group-dm:${m.user_id}`).emit('group-dm:received', message)
    }
    socket.emit('group-dm:sent', message)
  })

  socket.on('group-dm:edit', (payload: unknown) => {
    if (!checkSocketRateLimit(socket, 'dm:edit', 20, 10_000)) return
    if (!userId || !isRecord(payload)) return
    const { messageId, content } = payload
    if (!isId(messageId) || !isText(content, maxGroupDmLength(true))) return

    const db = getDb()
    const gdm = db
      .prepare(
        `
      SELECT gdm.* FROM group_dm_messages gdm
      WHERE gdm.id = ? AND gdm.from_id = ?
    `,
      )
      .get(messageId, userId) as
      | {
          id: string
          channel_id: string
          from_id: string
          from_username: string
          content: string
          encrypted: number
          created_at: number
        }
      | undefined
    // A member who left the group keeps authorship but loses edit rights.
    if (!gdm || !isGroupDmMember(userId, gdm.channel_id)) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }
    if (content.length > maxGroupDmLength(gdm.encrypted === 1)) return

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE group_dm_messages SET content = ?, edited_at = ? WHERE id = ?').run(
      content.trim(),
      now,
      messageId,
    )

    const userRow = db
      .prepare('SELECT display_name, avatar FROM users WHERE id = ?')
      .get(userId) as { display_name: string | null; avatar: string | null } | undefined
    const edited = {
      id: gdm.id,
      channel_id: gdm.channel_id,
      user_id: gdm.from_id,
      username: gdm.from_username,
      display_name: userRow?.display_name || gdm.from_username,
      avatar: userRow?.avatar || undefined,
      content: content.trim(),
      encrypted: gdm.encrypted,
      edited_at: now * 1000,
      created_at: gdm.created_at * 1000,
    }

    const members = db
      .prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ?')
      .all(gdm.channel_id) as { user_id: string }[]

    for (const m of members) {
      io.to(`group-dm:${m.user_id}`).emit('group-dm:edit', edited)
    }
  })

  socket.on('group-dm:delete', (payload: unknown) => {
    if (!userId || !isRecord(payload)) return
    const { messageId } = payload
    if (!isId(messageId)) return
    const db = getDb()
    const gdm = db
      .prepare(
        `
      SELECT gdm.* FROM group_dm_messages gdm
      WHERE gdm.id = ? AND gdm.from_id = ?
    `,
      )
      .get(messageId, userId) as { channel_id: string } | undefined
    if (!gdm) return

    db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM group_dm_messages WHERE id = ?').run(messageId)

    const members = db
      .prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ?')
      .all(gdm.channel_id) as { user_id: string }[]

    for (const m of members) {
      io.to(`group-dm:${m.user_id}`).emit('group-dm:delete', {
        id: messageId,
        channel_id: gdm.channel_id,
      })
    }
  })

  socket.on('group-dm:read', (payload: unknown, callback?: unknown) => {
    if (!userId || !isRecord(payload)) return
    const { channelId } = payload
    if (!isId(channelId)) return
    if (!isGroupDmMember(userId, channelId)) {
      if (typeof callback === 'function') callback({ error: 'Channel not found' })
      return
    }
    const now = Math.floor(Date.now() / 1000)
    prep(
      `INSERT INTO group_dm_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    ).run(userId, channelId, now)

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })
}
