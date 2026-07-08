import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import { getUserPermissions, hasPermission } from '../../middleware/auth'
import { prep, checkSocketRateLimit } from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'

export function registerDmHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('dm:read', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId || !channelId) return
    const now = Math.floor(Date.now() / 1000)
    prep(
      `INSERT INTO dm_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(userId, channelId, now)

    const channel = prep('SELECT user1_id, user2_id FROM dm_channels WHERE id = ?').get(channelId) as { user1_id: string; user2_id: string } | undefined
    if (channel) {
      const otherUserId = channel.user1_id === userId ? channel.user2_id : channel.user1_id
      socket.to(`user:${otherUserId}`).emit('dm:read', { channelId, readBy: userId, readAt: now * 1000 })
    }

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })

  // ─── Group DM Messages ────────────────────────────

  socket.on('dm:send', ({ toUserId, content, encrypted }: {
    toUserId: string
    content: string
    encrypted?: boolean
  }) => {
    if (!checkSocketRateLimit(socket, 'dm:send', 30, 10_000)) return
    if (!toUserId || !content?.trim() || !userId) return

    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'send_dm_messages')) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'You do not have permission to send direct messages' })
      return
    }

    const db = getDb()
    const [user1Id, user2Id] = [userId, toUserId].sort()
    let channel = db.prepare(
      'SELECT * FROM dm_channels WHERE user1_id = ? AND user2_id = ?'
    ).get(user1Id, user2Id) as { id: string } | undefined

    if (!channel) {
      const channelId = uuidv4()
      db.prepare('INSERT OR IGNORE INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(channelId, user1Id, user2Id)
      channel = db.prepare('SELECT * FROM dm_channels WHERE user1_id = ? AND user2_id = ?').get(user1Id, user2Id) as { id: string } | undefined
      channel = { id: channelId }
    }

    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content, encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, channel.id, userId, username, toUserId, content.trim(), encrypted ? 1 : 0, now)

    db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?').run(now, channel.id)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as { display_name: string | null; avatar: string | null } | undefined

    const dm = {
      id,
      channel_id: channel.id,
      user_id: userId,
      username,
      display_name: userRow?.display_name || username,
      avatar: userRow?.avatar || undefined,
      content: content.trim(),
      encrypted: encrypted ? 1 : 0,
      created_at: now * 1000,
    }
    io.to(`dm:${toUserId}`).emit('dm:received', dm)
    socket.emit('dm:sent', dm)
  })

  socket.on('dm:edit', ({ messageId, content }: {
    messageId: string
    content: string
  }) => {
    if (!checkSocketRateLimit(socket, 'dm:edit', 20, 10_000)) return
    if (!messageId || !content?.trim() || !userId) return
    if (content.length > 2700) return

    const db = getDb()
    const dm = db.prepare(`
      SELECT dm.*, dc.user1_id, dc.user2_id
      FROM direct_messages dm
      JOIN dm_channels dc ON dc.id = dm.channel_id
      WHERE dm.id = ? AND dm.from_id = ?
    `).get(messageId, userId) as { id: string; channel_id: string; from_id: string; from_username: string; content: string; encrypted: number; created_at: number; user1_id: string; user2_id: string } | undefined
    if (!dm) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE direct_messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), now, messageId)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as { display_name: string | null; avatar: string | null } | undefined
    const edited = {
      id: dm.id,
      channel_id: dm.channel_id,
      user_id: dm.from_id,
      username: dm.from_username,
      display_name: userRow?.display_name || dm.from_username,
      avatar: userRow?.avatar || undefined,
      content: content.trim(),
      encrypted: dm.encrypted,
      edited_at: now * 1000,
      created_at: dm.created_at * 1000,
    }

    const toId = dm.user1_id === userId ? dm.user2_id : dm.user1_id
    io.to(`dm:${toId}`).emit('dm:edit', edited)
    socket.emit('dm:edit', edited)
  })

  socket.on('dm:delete', ({ messageId }: { messageId: string }) => {
    if (!userId) return
    const db = getDb()
    const dm = db.prepare(`
      SELECT dm.*, dc.user1_id, dc.user2_id
      FROM direct_messages dm
      JOIN dm_channels dc ON dc.id = dm.channel_id
      WHERE dm.id = ? AND dm.from_id = ?
    `).get(messageId, userId) as { channel_id: string; user1_id: string; user2_id: string } | undefined
    if (!dm) return

    db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM direct_messages WHERE id = ?').run(messageId)

    const toId = dm.user1_id === userId ? dm.user2_id : dm.user1_id
    io.to(`dm:${toId}`).emit('dm:delete', { id: messageId, channel_id: dm.channel_id })
    socket.emit('dm:delete', { id: messageId, channel_id: dm.channel_id })
  })

  // ─── DM Voice Calls ──────────────────────────────────
}
