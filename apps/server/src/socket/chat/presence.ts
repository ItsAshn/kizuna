import type { Server, Socket } from 'socket.io'
import { getDb } from '../../db'
import { prep, clearSocketRateLimits, dmCalls, groupDMCalls, userConnections, userStatuses, userActivities, type UserActivity, type UserStatus } from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'

export function registerPresenceHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('user:joined', () => {
    if (!userId) return
    socket.data.userId = userId
    socket.data.username = username

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
      const savedStatus = (row?.status && ['online', 'idle', 'busy', 'invisible'].includes(row.status)) ? (row.status as UserStatus) : 'online'
      userStatuses.set(userId, savedStatus)
      if (savedStatus === 'invisible') {
        socket.emit('user:online', { userId, username, status: savedStatus })
      } else {
        io.emit('user:online', { userId, username, status: savedStatus })
      }
    }

    const db2 = getDb()
    const onlineUserIds = Array.from(userStatuses.keys()).filter(uid => userStatuses.get(uid) !== 'invisible')
    const usernameMap = new Map<string, string>()
    if (onlineUserIds.length > 0) {
      const placeholders = onlineUserIds.map(() => '?').join(',')
      const userRows = db2.prepare(
        `SELECT id, username FROM users WHERE id IN (${placeholders})`
      ).all(...onlineUserIds) as { id: string; username: string }[]
      for (const row of userRows) {
        usernameMap.set(row.id, row.username)
      }
    }
    const onlineList: Record<string, { username: string; status: UserStatus; activity?: UserActivity | null }> = {}
    for (const uid of onlineUserIds) {
      onlineList[uid] = {
        username: usernameMap.get(uid) || 'unknown',
        status: userStatuses.get(uid)!,
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

  socket.on('user:status', ({ status, status_text, status_emoji, status_sticker_id }: { status?: UserStatus; status_text?: string | null; status_emoji?: string | null; status_sticker_id?: string | null }) => {
    if (!userId) return
    const db = getDb()
    const prevStatus = userStatuses.get(userId)
    if (status && ['online', 'idle', 'busy', 'invisible'].includes(status)) {
      userStatuses.set(userId, status)
      try {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId)
      } catch { /* ignore */ }
    }
    const textPayload: Record<string, unknown> = { userId }
    if (status !== undefined) textPayload.status = status
    if (status_text !== undefined) textPayload.status_text = status_text
    if (status_emoji !== undefined) textPayload.status_emoji = status_emoji
    if (status_sticker_id !== undefined) textPayload.status_sticker_id = status_sticker_id
    if (status === 'invisible' && prevStatus !== 'invisible') {
      socket.emit('user:status', textPayload)
      socket.broadcast.emit('user:offline', { userId })
    } else if (prevStatus === 'invisible' && status && status !== 'invisible') {
      io.emit('user:online', { userId, username, status })
      if (status_text !== undefined || status_emoji !== undefined || status_sticker_id !== undefined) {
        const extra: Record<string, unknown> = { userId }
        if (status_text !== undefined) extra.status_text = status_text
        if (status_emoji !== undefined) extra.status_emoji = status_emoji
        if (status_sticker_id !== undefined) extra.status_sticker_id = status_sticker_id
        io.emit('user:status', extra)
      }
    } else {
      io.emit('user:status', textPayload)
    }
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
        const wasInvisible = userStatuses.get(userId) === 'invisible'
        userConnections.delete(userId)
        userStatuses.delete(userId)
        userActivities.delete(userId)
        if (!wasInvisible) {
          io.emit('user:offline', { userId })
        }
      }
    }
  })

  // ─── Reactions ───────────────────────────────────────
}
