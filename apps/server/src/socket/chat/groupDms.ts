import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import { getUserPermissions, hasPermission } from '../../middleware/auth'
import { prep, checkSocketRateLimit } from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'

export function registerGroupDmHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('group-dm:send', ({ channelId, content, encrypted }: {
    channelId: string
    content: string
    encrypted?: boolean
  }) => {
    if (!checkSocketRateLimit(socket, 'dm:send', 30, 10_000)) return
    if (!channelId || !content?.trim() || !userId) return

    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'send_dm_messages')) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'You do not have permission to send direct messages' })
      return
    }

    const db = getDb()
    const isMember = db.prepare(
      'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, userId)
    if (!isMember) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Not a member of this group' })
      return
    }

    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO group_dm_messages (id, channel_id, from_id, from_username, content, encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, channelId, userId, username, content.trim(), encrypted ? 1 : 0, now)

    db.prepare('UPDATE group_dm_channels SET last_message_at = ? WHERE id = ?').run(now, channelId)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as { display_name: string | null; avatar: string | null } | undefined
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

    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ? AND user_id != ?'
    ).all(channelId, userId) as { user_id: string }[]

    for (const m of members) {
      io.to(`group-dm:${m.user_id}`).emit('group-dm:received', message)
    }
    socket.emit('group-dm:sent', message)
  })

  socket.on('group-dm:edit', ({ messageId, content }: {
    messageId: string
    content: string
  }) => {
    if (!checkSocketRateLimit(socket, 'dm:edit', 20, 10_000)) return
    if (!messageId || !content?.trim() || !userId) return
    if (content.length > 2700) return

    const db = getDb()
    const gdm = db.prepare(`
      SELECT gdm.* FROM group_dm_messages gdm
      WHERE gdm.id = ? AND gdm.from_id = ?
    `).get(messageId, userId) as { id: string; channel_id: string; from_id: string; from_username: string; content: string; encrypted: number; created_at: number } | undefined
    if (!gdm) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE group_dm_messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), now, messageId)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as { display_name: string | null; avatar: string | null } | undefined
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

    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(gdm.channel_id) as { user_id: string }[]

    for (const m of members) {
      io.to(`group-dm:${m.user_id}`).emit('group-dm:edit', edited)
    }
  })

  socket.on('group-dm:delete', ({ messageId }: { messageId: string }) => {
    if (!userId) return
    const db = getDb()
    const gdm = db.prepare(`
      SELECT gdm.* FROM group_dm_messages gdm
      WHERE gdm.id = ? AND gdm.from_id = ?
    `).get(messageId, userId) as { channel_id: string } | undefined
    if (!gdm) return

    db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM group_dm_messages WHERE id = ?').run(messageId)

    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(gdm.channel_id) as { user_id: string }[]

    for (const m of members) {
      io.to(`group-dm:${m.user_id}`).emit('group-dm:delete', { id: messageId, channel_id: gdm.channel_id })
    }
  })

  socket.on('group-dm:read', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId || !channelId) return
    const now = Math.floor(Date.now() / 1000)
    prep(
      `INSERT INTO group_dm_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(userId, channelId, now)

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })
}
