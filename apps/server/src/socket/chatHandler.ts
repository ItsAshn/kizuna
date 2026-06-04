import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { getUserPermissions, hasPermission } from '../middleware/auth'

interface MentionResult {
  type: 'everyone' | 'here' | 'user'
  target: string | null
}

export function parseMentions(content: string): MentionResult[] {
  const results: MentionResult[] = []
  const seen = new Set<string>()

  if (/@everyone\b/.test(content) && !seen.has('everyone')) {
    results.push({ type: 'everyone', target: null })
    seen.add('everyone')
  }
  if (/@here\b/.test(content) && !seen.has('here')) {
    results.push({ type: 'here', target: null })
    seen.add('here')
  }

  const userPattern = /@([\w.\-]+)/g
  let match
  while ((match = userPattern.exec(content)) !== null) {
    const username = match[1].toLowerCase()
    if (username === 'everyone' || username === 'here') continue
    if (!seen.has(username)) {
      results.push({ type: 'user', target: username })
      seen.add(username)
    }
  }

  return results
}

export function processMentions(io: Server, message: any, mentions: MentionResult[]): void {
  if (!mentions.length) return
  const db = getDb()

  for (const mention of mentions) {
    const mentionId = uuidv4()
    const base = {
      id: mentionId,
      message_id: message.id,
      channel_id: message.channel_id,
      author_id: message.author_id || message.user_id,
      author_username: message.author_username || message.username,
      content: message.content,
      mention_type: mention.type,
    }

    if (mention.type === 'everyone' || mention.type === 'here') {
      db.prepare(
        `INSERT OR IGNORE INTO mentions
         (id, message_id, channel_id, author_id, author_username, content, mention_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(mentionId, message.id, message.channel_id, base.author_id, base.author_username, message.content, mention.type)

      io.to('__notifications__').emit('message:mention', {
        ...base,
        mentionedUserId: null,
      })
    } else {
      const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(mention.target!) as { id: string; username: string } | undefined
      if (!user) continue

      db.prepare(
        `INSERT OR IGNORE INTO mentions
         (id, message_id, channel_id, author_id, author_username, mentioned_user_id, content, mention_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(mentionId, message.id, message.channel_id, base.author_id, base.author_username, user.id, message.content, 'user')

      io.to(`user:${user.id}`).emit('message:mention', {
        ...base,
        mentionedUserId: user.id,
      })
    }
  }
}

export function registerChatHandlers(io: Server, socket: Socket): void {
  const NOTIFICATION_ROOM = '__notifications__'

  socket.on('notification:subscribe', () => {
    socket.join(NOTIFICATION_ROOM)
  })

  socket.on('user:subscribe', ({ userId }: { userId: string }) => {
    if (userId) {
      socket.join(`user:${userId}`)
      socket.join(`dm:${userId}`)
      ;(socket as any).userId = userId
    }
  })

  socket.on('dm:subscribe', ({ userId }: { userId: string }) => {
    if (userId) {
      socket.join(`dm:${userId}`)
    }
  })

  socket.on('channel:join', (channelId: string) => {
    socket.join(channelId)
    ;(socket as any).currentChannel = channelId
  })

  socket.on('channel:leave', (channelId: string) => {
    socket.leave(channelId)
  })

  socket.on('message:send', ({ channelId, content, authorId, authorUsername }: {
    channelId: string
    content: string
    authorId: string
    authorUsername: string
  }) => {
    if (!channelId || !content?.trim() || !authorId) return
    if (content.length > 4000) return

    const userInfo = getUserPermissions(authorId)
    if (!hasPermission(userInfo!, 'send_messages')) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'You do not have permission to send messages' })
      return
    }

    const db = getDb()
    const id = uuidv4()
    db.prepare(
      `INSERT INTO messages (id, channel_id, author_id, author_username, content)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, channelId, authorId, authorUsername, content.trim())

    const row = db.prepare(
      `SELECT m.*, u.display_name, u.avatar
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.id = ?`
    ).get(id) as any

    const message = {
      id: row.id,
      channel_id: row.channel_id,
      user_id: row.author_id,
      username: row.author_username,
      display_name: row.display_name || row.author_username,
      avatar: row.avatar || undefined,
      content: row.content,
      created_at: row.created_at * 1000,
    }

    io.to(channelId).emit('message:new', message)
    io.to(NOTIFICATION_ROOM).emit('message:new', message)

    const mentions = parseMentions(content.trim())
    processMentions(io, { ...message, author_id: row.author_id, author_username: row.author_username }, mentions)
  })

  socket.on('message:edit', ({ messageId, content, authorId }: {
    messageId: string
    content: string
    authorId: string
  }) => {
    if (!messageId || !content?.trim()) return
    if (content.length > 4000) return

    const db = getDb()
    const existing = db.prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?').get(messageId, authorId) as any
    if (!existing) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)'
    ).run(uuidv4(), messageId, existing.content, authorId, now)
    db.prepare('UPDATE messages SET content = ?, edited_at = ?, updated_at = ? WHERE id = ?').run(
      content.trim(), now, now, messageId,
    )

    const row = db.prepare(
      `SELECT m.*, u.display_name, u.avatar
       FROM messages m
       LEFT JOIN users u ON m.author_id = u.id
       WHERE m.id = ?`
    ).get(messageId) as any

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
  })

  socket.on('message:delete', ({ messageId, authorId }: { messageId: string; authorId: string }) => {
    const db = getDb()
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any
    if (!message) return

    const userPerms = getUserPermissions(authorId)
    if (message.author_id !== authorId && (!userPerms || !hasPermission(userPerms, 'delete_messages'))) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot delete this message' })
      return
    }

    db.prepare('DELETE FROM mentions WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    io.to(message.channel_id).emit('message:delete', { id: messageId, channel_id: message.channel_id })
  })

  socket.on('mentions:read', ({ userId, channelId }: { userId: string; channelId?: string }) => {
    if (!userId) return
    const db = getDb()
    if (channelId) {
      db.prepare(
        `UPDATE mentions SET read = 1
         WHERE (mentioned_user_id = ? OR mention_type IN ('everyone', 'here'))
           AND channel_id = ? AND read = 0`
      ).run(userId, channelId)
    } else {
      db.prepare(
        `UPDATE mentions SET read = 1
         WHERE (mentioned_user_id = ? OR mention_type IN ('everyone', 'here')) AND read = 0`
      ).run(userId)
    }
  })

  socket.on('channel:read', ({ userId, channelId }: { userId: string; channelId: string }, callback?: Function) => {
    if (!userId || !channelId) return
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO channel_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(userId, channelId, now)

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })

  socket.on('dm:read', ({ userId, channelId }: { userId: string; channelId: string }, callback?: Function) => {
    if (!userId || !channelId) return
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO dm_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(userId, channelId, now)

    const channel = db.prepare('SELECT user1_id, user2_id FROM dm_channels WHERE id = ?').get(channelId) as any
    if (channel) {
      const otherUserId = channel.user1_id === userId ? channel.user2_id : channel.user1_id
      socket.to(`user:${otherUserId}`).emit('dm:read', { channelId, readBy: userId, readAt: now * 1000 })
    }

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })

  socket.on('channel:unread', ({ userId }: { userId: string }, callback?: Function) => {
    if (!userId || typeof callback !== 'function') return
    const db = getDb()
    const rows = db.prepare(
      'SELECT channel_id, last_read_at FROM channel_reads WHERE user_id = ?'
    ).all(userId) as { channel_id: string; last_read_at: number }[]

    const lastRead = new Map(rows.map(r => [r.channel_id, r.last_read_at]))
    const channels = db.prepare("SELECT id FROM channels WHERE type = 'text'").all() as { id: string }[]

    const unreadCounts: Record<string, number> = {}
    for (const ch of channels) {
      const threshold = lastRead.get(ch.id) || 0
      const count = db.prepare(
        'SELECT COUNT(*) as count FROM messages WHERE channel_id = ? AND created_at > ?'
      ).get(ch.id, threshold) as { count: number }
      if (count.count > 0) unreadCounts[ch.id] = count.count
    }

    callback(unreadCounts)
  })

  socket.on('mentions:unread', ({ userId }: { userId: string }, callback?: Function) => {
    if (!userId || typeof callback !== 'function') return
    const db = getDb()
    const rows = db.prepare(
      `SELECT channel_id, COUNT(*) as count FROM mentions
       WHERE (mentioned_user_id = ? OR mention_type IN ('everyone', 'here')) AND read = 0
       GROUP BY channel_id`
    ).all(userId)
    callback(rows)
  })

  socket.on('typing:start', ({ channelId, username }: { channelId: string; username: string }) => {
    socket.to(channelId).emit('typing:start', { username })
  })

  socket.on('typing:stop', ({ channelId, username }: { channelId: string; username: string }) => {
    socket.to(channelId).emit('typing:stop', { username })
  })

  socket.on('dm:send', ({ toUserId, fromId, fromUsername, content, encrypted }: {
    toUserId: string
    fromId: string
    fromUsername: string
    content: string
    encrypted?: boolean
  }) => {
    if (!toUserId || !content?.trim()) return

    const db = getDb()
    let channel = db.prepare(
      'SELECT * FROM dm_channels WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)'
    ).get(fromId, toUserId, toUserId, fromId) as any

    if (!channel) {
      const channelId = uuidv4()
      db.prepare('INSERT INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(channelId, fromId, toUserId)
      channel = { id: channelId }
    }

    const id = uuidv4()
    db.prepare(
      'INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, channel.id, fromId, fromUsername, toUserId, content.trim(), encrypted ? 1 : 0)

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?').run(now, channel.id)

    const dm = {
      id,
      channel_id: channel.id,
      user_id: fromId,
      username: fromUsername,
      content: content.trim(),
      encrypted: encrypted ? 1 : 0,
      created_at: Date.now(),
    }
    io.to(`dm:${toUserId}`).emit('dm:received', dm)
    socket.emit('dm:sent', dm)
  })

  socket.on('user:joined', ({ userId, username }: { userId: string; username: string }) => {
    ;(socket as any).userId = userId
    ;(socket as any).username = username

    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    try {
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId)
    } catch { /* ignore */ }

    socket.broadcast.emit('user:online', { userId, username, socketId: socket.id })
  })

  socket.on('presence:heartbeat', ({ userId }: { userId: string }) => {
    if (!userId) return
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    try {
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId)
    } catch { /* ignore */ }
  })

  socket.on('disconnect', () => {
    const userId = (socket as any).userId
    if (userId) {
      socket.broadcast.emit('user:offline', { userId })
    }
  })
}
