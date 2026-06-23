import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import Database from 'better-sqlite3'
import { getDb } from '../db'
import { getUserPermissions, hasPermission, canWriteToChannel } from '../middleware/auth'

const stmtCache = new Map<string, Database.Statement>()
function prep(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql)
  if (!stmt) {
    stmt = getDb().prepare(sql)
    stmtCache.set(sql, stmt)
  }
  return stmt
}

const MAX_SOCKET_RATE_STORE = 50_000
const socketRateLimits = new Map<string, { count: number; resetAt: number }>()

function checkSocketRateLimit(socket: Socket, event: string, max: number, windowMs: number): boolean {
  const key = `${socket.id}:${event}`
  const now = Date.now()
  const entry = socketRateLimits.get(key)
  if (!entry || entry.resetAt <= now) {
    if (socketRateLimits.size >= MAX_SOCKET_RATE_STORE) {
      socketRateLimits.clear()
    }
    socketRateLimits.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

function clearSocketRateLimits(socketId: string): void {
  for (const key of socketRateLimits.keys()) {
    if (key.startsWith(`${socketId}:`)) socketRateLimits.delete(key)
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of socketRateLimits) {
    if (entry.resetAt <= now) socketRateLimits.delete(key)
  }
}, 60_000).unref()

const dmCalls = new Map<
  string,
  {
    dmChannelId: string
    callerId: string
    callerUsername: string
    calleeId: string
    calleeUsername: string
    status: 'ringing' | 'active'
    startedAt: number
  }
>()

const groupDMCalls = new Map<
  string,
  {
    channelId: string
    callerId: string
    callerUsername: string
    status: 'ringing' | 'active'
    startedAt: number
  }
>()

setInterval(() => {
  const now = Date.now()
  const staleTimeout = 300_000
  for (const [key, call] of dmCalls) {
    if (call.status === 'ringing' && now - call.startedAt > staleTimeout) dmCalls.delete(key)
  }
  for (const [key, call] of groupDMCalls) {
    if (call.status === 'ringing' && now - call.startedAt > staleTimeout) groupDMCalls.delete(key)
  }
}, 60_000).unref()

interface MentionResult {
  type: 'everyone' | 'here' | 'user' | 'role';
  target: string | null;
}

type UserStatus = 'online' | 'idle' | 'busy' | 'offline'

interface UserActivity {
  type: 'game' | 'music' | 'video' | 'other'
  name: string
  details?: string
  state?: string
  timestamps?: { start?: number }
}

const userConnections = new Map<string, Set<string>>()
const userStatuses = new Map<string, UserStatus>()
const userActivities = new Map<string, UserActivity>()

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

  const userPattern = /@([\w.-]+)/g
  let match
  while ((match = userPattern.exec(content)) !== null) {
    const username = match[1]!.toLowerCase()
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
      // Check if this matches a mentionable role first
      const role = db.prepare(
        "SELECT id, name FROM roles WHERE LOWER(name) = ? AND mentionable = 1"
      ).get(mention.target!.toLowerCase()) as { id: string; name: string } | undefined

      if (role) {
        const roleMembers = db.prepare(
          'SELECT user_id FROM member_roles WHERE role_id = ?'
        ).all(role.id) as { user_id: string }[]

        for (const rm of roleMembers) {
          const roleMentionId = uuidv4()
          db.prepare(
            `INSERT OR IGNORE INTO mentions
             (id, message_id, channel_id, author_id, author_username, mentioned_user_id, content, mention_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(roleMentionId, message.id, message.channel_id, base.author_id, base.author_username, rm.user_id, message.content, 'role')

          io.to(`user:${rm.user_id}`).emit('message:mention', {
            ...base,
            id: roleMentionId,
            mention_type: 'role',
            mentioned_user_id: rm.user_id,
            role_name: role.name,
            role_id: role.id,
          })
        }
        continue
      }

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

function getSocketUserId(socket: Socket): string {
  return socket.data.userId || (socket as any).userId
}

function getSocketUsername(socket: Socket): string {
  return socket.data.username || (socket as any).username || 'unknown'
}

export function getMessageInfo(
  db: ReturnType<typeof getDb>,
  messageId: string,
): { channel_id: string; isDM: boolean; isGroupDM?: boolean; participants?: { user1_id: string; user2_id: string }; groupMembers?: string[] } | null {
  const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId) as any;
  if (msg) return { channel_id: msg.channel_id, isDM: false };

  const dm = db
    .prepare(
      `SELECT dm.channel_id, dc.user1_id, dc.user2_id
       FROM direct_messages dm
       JOIN dm_channels dc ON dc.id = dm.channel_id
       WHERE dm.id = ?`,
    )
    .get(messageId) as any;
  if (dm)
    return {
      channel_id: dm.channel_id,
      isDM: true,
      participants: { user1_id: dm.user1_id, user2_id: dm.user2_id },
    };

  const gdm = db
    .prepare(
      `SELECT gdm.channel_id
       FROM group_dm_messages gdm
       WHERE gdm.id = ?`,
    )
    .get(messageId) as any;
  if (gdm) {
    const gm = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(gdm.channel_id) as { user_id: string }[];
    return {
      channel_id: gdm.channel_id,
      isDM: false,
      isGroupDM: true,
      groupMembers: gm.map(r => r.user_id),
    };
  }

  return null;
}

export function broadcastReaction(
  io: Server,
  msgInfo: { channel_id: string; isDM: boolean; isGroupDM?: boolean; participants?: { user1_id: string; user2_id: string }; groupMembers?: string[] },
  event: string,
  payload: unknown,
) {
  if (msgInfo.isDM && msgInfo.participants) {
    io.to(`dm:${msgInfo.participants.user1_id}`).emit(event, payload);
    io.to(`dm:${msgInfo.participants.user2_id}`).emit(event, payload);
  } else if (msgInfo.isGroupDM && msgInfo.groupMembers) {
    for (const userId of msgInfo.groupMembers) {
      io.to(`group-dm:${userId}`).emit(event, payload);
    }
  } else {
    io.to(msgInfo.channel_id).emit(event, payload);
  }
}

function getSocketUsernameById(userId: string, db: ReturnType<typeof getDb>): string {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
  return row?.username || 'unknown'
}

export function registerChatHandlers(io: Server, socket: Socket): void {
  const NOTIFICATION_ROOM = '__notifications__'
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('notification:subscribe', () => {
    socket.join(NOTIFICATION_ROOM)
  })

  socket.on('channel:mute:sync', () => {
    if (!userId) return
    const db = getDb()
    const rows = db.prepare(
      `SELECT channel_id, muted_until FROM channel_mutes
       WHERE user_id = ? AND (muted_until IS NULL OR muted_until > unixepoch())`
    ).all(userId) as { channel_id: string; muted_until: number | null }[]

    const mutes: Record<string, number | null> = {}
    for (const r of rows) {
      mutes[r.channel_id] = r.muted_until ? r.muted_until * 1000 : null
    }
    socket.emit('channel:mute:sync', mutes)
  })

  socket.on('user:subscribe', () => {
    if (userId) {
      socket.join(`user:${userId}`)
      socket.join(`dm:${userId}`)
      socket.join(`group-dm:${userId}`)
      ;(socket as any).userId = userId
    }
  })

  socket.on('dm:subscribe', () => {
    if (userId) {
      socket.join(`dm:${userId}`)
    }
  })

  socket.on('group-dm:subscribe', () => {
    if (userId) {
      socket.join(`group-dm:${userId}`)
    }
  })

  socket.on('channel:join', (channelId: string) => {
    socket.join(channelId)
    ;(socket as any).currentChannel = channelId
  })

  socket.on('channel:leave', (channelId: string) => {
    socket.leave(channelId)
  })

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
      socket.emit('error', { code: 'LOCKED', message: 'This channel is locked' })
      return
    }

    const db = getDb()
    const id = uuidv4()
    let replyUsername: string | null = null
    let replyContent: string | null = null
    if (replyToMessageId) {
      const replyMsg = db.prepare('SELECT author_username, content FROM messages WHERE id = ? AND channel_id = ?').get(replyToMessageId, channelId) as any
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

    const db = getDb()
    const existing = db.prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?').get(messageId, userId) as any
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

    io.to(existing.channel_id).to(NOTIFICATION_ROOM).emit('message:edit', updated)
  })

  socket.on('message:delete', ({ messageId }: { messageId: string }) => {
    if (!userId) return
    const db = getDb()
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any
    if (!message) return

    const userPerms = getUserPermissions(userId)
    if (message.author_id !== userId && (!userPerms || !hasPermission(userPerms, 'delete_messages'))) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot delete this message' })
      return
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

  socket.on('dm:read', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId || !channelId) return
    const now = Math.floor(Date.now() / 1000)
    prep(
      `INSERT INTO dm_reads (user_id, channel_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = excluded.last_read_at`
    ).run(userId, channelId, now)

    const channel = prep('SELECT user1_id, user2_id FROM dm_channels WHERE id = ?').get(channelId) as any
    if (channel) {
      const otherUserId = channel.user1_id === userId ? channel.user2_id : channel.user1_id
      socket.to(`user:${otherUserId}`).emit('dm:read', { channelId, readBy: userId, readAt: now * 1000 })
    }

    if (typeof callback === 'function') {
      callback({ success: true, last_read_at: now * 1000 })
    }
  })

  // ─── Group DM Messages ────────────────────────────

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

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as any
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
    `).get(messageId, userId) as any
    if (!gdm) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE group_dm_messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), now, messageId)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as any
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
    `).get(messageId, userId) as any
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

  socket.on('channel:unread', (_, callback?: Function) => {
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
    ).get(user1Id, user2Id) as any

    if (!channel) {
      const channelId = uuidv4()
      db.prepare('INSERT OR IGNORE INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(channelId, user1Id, user2Id)
      channel = db.prepare('SELECT * FROM dm_channels WHERE user1_id = ? AND user2_id = ?').get(user1Id, user2Id) as any
      channel = { id: channelId }
    }

    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content, encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, channel.id, userId, username, toUserId, content.trim(), encrypted ? 1 : 0, now)

    db.prepare('UPDATE dm_channels SET last_message_at = ? WHERE id = ?').run(now, channel.id)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as any

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
    `).get(messageId, userId) as any
    if (!dm) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Cannot edit this message' })
      return
    }

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE direct_messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), now, messageId)

    const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as any
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
    `).get(messageId, userId) as any
    if (!dm) return

    db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId)
    db.prepare('DELETE FROM direct_messages WHERE id = ?').run(messageId)

    const toId = dm.user1_id === userId ? dm.user2_id : dm.user1_id
    io.to(`dm:${toId}`).emit('dm:delete', { id: messageId, channel_id: dm.channel_id })
    socket.emit('dm:delete', { id: messageId, channel_id: dm.channel_id })
  })

  // ─── DM Voice Calls ──────────────────────────────────

  socket.on('dm:call:start', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId || !username) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to start DM calls' })
      return
    }
    const db = getDb()
    const dmChannel = db.prepare(
      'SELECT * FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)'
    ).get(dmChannelId, userId, userId) as any
    if (!dmChannel) {
      if (typeof callback === 'function') callback({ error: 'DM channel not found' })
      return
    }
    const existing = [...dmCalls.values()].find(
      c => c.dmChannelId === dmChannelId && c.status !== 'active'
    )
    if (existing) {
      if (typeof callback === 'function') callback({ error: 'A call is already in progress' })
      return
    }
    const calleeId = dmChannel.user1_id === userId ? dmChannel.user2_id : dmChannel.user1_id
    const calleeRow = db.prepare('SELECT username FROM users WHERE id = ?').get(calleeId) as any
    const calleeUsername = calleeRow?.username || 'Unknown'

    dmCalls.set(dmChannelId, {
      dmChannelId,
      callerId: userId,
      callerUsername: username,
      calleeId,
      calleeUsername,
      status: 'ringing',
      startedAt: Date.now(),
    })

    const calleeSockets = io.sockets.adapter.rooms.get(`user:${calleeId}`)
    if (!calleeSockets || calleeSockets.size === 0) {
      dmCalls.delete(dmChannelId)
      if (typeof callback === 'function') callback({ error: 'User is offline' })
      return
    }

    io.to(`user:${calleeId}`).emit('dm:call:incoming', {
      dmChannelId,
      callerUserId: userId,
      callerUsername: username,
      calleeUserId: calleeId,
      calleeUsername,
    })

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('dm:call:accept', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to accept DM calls' })
      return
    }
    const call = dmCalls.get(dmChannelId)
    if (!call || call.calleeId !== userId) {
      if (typeof callback === 'function') callback({ error: 'No pending call' })
      return
    }
    call.status = 'active'
    io.to(`user:${call.callerId}`).emit('dm:call:accepted', {
      dmChannelId,
      acceptedByUserId: userId,
      acceptedByUsername: username,
    })

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('dm:call:reject', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = dmCalls.get(dmChannelId)
    if (!call) {
      if (typeof callback === 'function') callback({ error: 'No pending call' })
      return
    }
    const isCaller = call.callerId === userId
    const isCallee = call.calleeId === userId
    if (!isCaller && !isCallee) {
      if (typeof callback === 'function') callback({ error: 'Not a participant' })
      return
    }
    const otherUserId = isCaller ? call.calleeId : call.callerId
    io.to(`user:${otherUserId}`).emit('dm:call:rejected', { dmChannelId })
    dmCalls.delete(dmChannelId)

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('dm:call:end', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = dmCalls.get(dmChannelId)
    if (!call) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    const isCaller = call.callerId === userId
    const isCallee = call.calleeId === userId
    if (!isCaller && !isCallee) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    const otherUserId = isCaller ? call.calleeId : call.callerId
    io.to(`user:${otherUserId}`).emit('dm:call:ended', { dmChannelId })
    dmCalls.delete(dmChannelId)

    if (typeof callback === 'function') callback({ ok: true })
  })

  // ─── Group DM Voice Calls ──────────────────────────

  socket.on('group-dm:call:start', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId || !username) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to start calls' })
      return
    }
    const db = getDb()
    const isMember = db.prepare(
      'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, userId)
    if (!isMember) {
      if (typeof callback === 'function') callback({ error: 'Not a member of this group' })
      return
    }
    const existing = groupDMCalls.get(channelId)
    if (existing && existing.status === 'ringing') {
      if (typeof callback === 'function') callback({ error: 'A call is already ringing' })
      return
    }

    const otherMembers = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ? AND user_id != ?'
    ).all(channelId, userId) as { user_id: string }[]

    const anyOnline = otherMembers.some(m => {
      const room = io.sockets.adapter.rooms.get(`user:${m.user_id}`)
      return room && room.size > 0
    })
    if (!anyOnline) {
      if (typeof callback === 'function') callback({ error: 'No other members are online' })
      return
    }

    groupDMCalls.set(channelId, {
      channelId,
      callerId: userId,
      callerUsername: username,
      status: 'ringing',
      startedAt: Date.now(),
    })

    for (const m of otherMembers) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:incoming', {
        channelId,
        callerUserId: userId,
        callerUsername: username,
      })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('group-dm:call:accept', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to accept calls' })
      return
    }
    const call = groupDMCalls.get(channelId)
    if (!call) {
      if (typeof callback === 'function') callback({ error: 'No pending call' })
      return
    }

    const db = getDb()
    const isMember = db.prepare(
      'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, userId)
    if (!isMember) {
      if (typeof callback === 'function') callback({ error: 'Not a member of this group' })
      return
    }

    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:accepted', {
        channelId,
        acceptedByUserId: userId,
        acceptedByUsername: username,
      })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('group-dm:call:reject', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = groupDMCalls.get(channelId)
    if (!call) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    groupDMCalls.delete(channelId)

    const db = getDb()
    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:rejected', { channelId })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('group-dm:call:end', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = groupDMCalls.get(channelId)
    if (!call) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    groupDMCalls.delete(channelId)

    const db = getDb()
    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:ended', { channelId })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('user:joined', () => {
    if (!userId) return
    ;(socket as any).userId = userId
    ;(socket as any).username = username

    const now = Math.floor(Date.now() / 1000)
    try {
      prep('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId)
    } catch { /* ignore */ }

    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set())
    }
    userConnections.get(userId)!.add(socket.id)

    if (userConnections.get(userId)!.size === 1) {
      const db = getDb()
      const row = db.prepare('SELECT status FROM users WHERE id = ?').get(userId) as { status?: string | null } | undefined
      const savedStatus = (row?.status && ['online', 'idle', 'busy'].includes(row.status)) ? (row.status as UserStatus) : 'online'
      userStatuses.set(userId, savedStatus)
      io.emit('user:online', { userId, username, status: savedStatus })
    }

    const db2 = getDb()
    const onlineList: Record<string, { username: string; status: UserStatus; activity?: UserActivity | null }> = {}
    for (const [uid, status] of userStatuses) {
      onlineList[uid] = {
        username: getSocketUsernameById(uid, db2),
        status,
        activity: userActivities.get(uid) || null,
      }
    }
    socket.emit('users:online', onlineList)
  })

  socket.on('presence:heartbeat', () => {
    if (!userId) return
    const now = Math.floor(Date.now() / 1000)
    try {
      prep('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId)
    } catch { /* ignore */ }
  })

  socket.on('user:status', ({ status, status_text, status_emoji }: { status?: UserStatus; status_text?: string | null; status_emoji?: string | null }) => {
    if (!userId) return
    const db = getDb()
    if (status && ['online', 'idle', 'busy'].includes(status)) {
      userStatuses.set(userId, status)
      try {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId)
      } catch { /* ignore */ }
    }
    const payload: any = { userId }
    if (status) payload.status = status
    if (status_text !== undefined) payload.status_text = status_text
    if (status_emoji !== undefined) payload.status_emoji = status_emoji
    io.emit('user:status', payload)
  })

  socket.on('user:activity', ({ activity }: { activity: UserActivity | null }) => {
    if (!userId) return
    if (activity) {
      userActivities.set(userId, activity)
      io.emit('user:activity', { userId, activity })
    } else {
      userActivities.delete(userId)
      io.emit('user:activity', { userId, activity: null })
    }
  })

  socket.on('disconnect', () => {
    if (!userId) return
    clearSocketRateLimits(socket.id)

    for (const [dmChannelId, call] of dmCalls) {
      if (call.callerId === userId || call.calleeId === userId) {
        const otherUserId = call.callerId === userId ? call.calleeId : call.callerId
        io.to(`user:${otherUserId}`).emit('dm:call:ended', { dmChannelId })
        dmCalls.delete(dmChannelId)
      }
    }

    for (const [channelId, call] of groupDMCalls) {
      const db = getDb()
      const isMember = db.prepare(
        'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
      ).get(channelId, userId)
      if (isMember || call.callerId === userId) {
        const members = db.prepare(
          'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
        ).all(channelId) as { user_id: string }[]
        for (const m of members) {
          io.to(`user:${m.user_id}`).emit('group-dm:call:ended', { channelId })
        }
        groupDMCalls.delete(channelId)
      }
    }

    const socks = userConnections.get(userId)
    if (socks) {
      socks.delete(socket.id)
      if (socks.size === 0) {
        userConnections.delete(userId)
        userStatuses.delete(userId)
        userActivities.delete(userId)
        io.emit('user:offline', { userId })
      }
    }
  })

  // ─── Reactions ───────────────────────────────────────

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

    const count = db.prepare('SELECT COUNT(*) as count FROM pinned_messages WHERE channel_id = ?').get(channelId) as any
    if (count.count >= 50) return

    const pinId = uuidv4()
    db.prepare('INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)').run(pinId, channelId, messageId, userId)

    const msg = db.prepare('SELECT content, author_id, author_username FROM messages WHERE id = ?').get(messageId) as any
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

  socket.on('thread:join', (threadId: string) => {
    socket.join(threadId)
  })

  socket.on('thread:leave', (threadId: string) => {
    socket.leave(threadId)
  })
}
