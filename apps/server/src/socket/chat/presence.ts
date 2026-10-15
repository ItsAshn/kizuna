import type { Server, Socket } from 'socket.io'
import { getDb } from '../../db'
import {
  prep,
  checkSocketRateLimit,
  clearSocketRateLimits,
  dmCalls,
  groupDMCalls,
  userConnections,
  userStatuses,
  userActivities,
  userSockets,
  type UserActivity,
  type UserStatus,
} from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'
import { isRecord } from '../validate'

const STATUSES: readonly UserStatus[] = ['online', 'idle', 'busy', 'invisible']
const ACTIVITY_TYPES: readonly UserActivity['type'][] = ['game', 'music', 'video', 'other']
// Activities are rebroadcast to every connected client, so keep them small.
const MAX_ACTIVITY_BYTES = 2048

const optionalString = (v: unknown, max: number): v is string | null | undefined =>
  v === undefined || v === null || (typeof v === 'string' && v.length <= max)

// Rebuilds the activity from known fields only, so arbitrary client keys are
// never relayed to everyone.
function sanitizeActivity(raw: unknown): UserActivity | null | undefined {
  if (raw === null) return null
  if (!isRecord(raw)) return undefined
  const { type, name, details, state, timestamps } = raw
  if (typeof type !== 'string' || !ACTIVITY_TYPES.includes(type as UserActivity['type'])) {
    return undefined
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) return undefined
  const activity: UserActivity = { type: type as UserActivity['type'], name }
  if (typeof details === 'string') activity.details = details.slice(0, 256)
  if (typeof state === 'string') activity.state = state.slice(0, 256)
  if (
    isRecord(timestamps) &&
    typeof timestamps.start === 'number' &&
    Number.isFinite(timestamps.start)
  ) {
    activity.timestamps = { start: timestamps.start }
  }
  if (Buffer.byteLength(JSON.stringify(activity), 'utf8') > MAX_ACTIVITY_BYTES) return undefined
  return activity
}

export function registerPresenceHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  if (userId) {
    let set = userSockets.get(userId)
    if (!set) {
      set = new Set()
      userSockets.set(userId, set)
    }
    set.add(socket.id)
  }

  socket.on('user:joined', () => {
    if (!userId) return
    socket.data.userId = userId
    socket.data.username = username

    const now = Math.floor(Date.now() / 1000)
    try {
      prep('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId)
    } catch {
      /* ignore */
    }

    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set())
    }
    userConnections.get(userId)!.add(socket.id)

    if (userConnections.get(userId)!.size === 1) {
      const db = getDb()
      const row = db.prepare('SELECT status FROM users WHERE id = ?').get(userId) as
        | { status?: string | null }
        | undefined
      const savedStatus =
        row?.status && ['online', 'idle', 'busy', 'invisible'].includes(row.status)
          ? (row.status as UserStatus)
          : 'online'
      userStatuses.set(userId, savedStatus)
      if (savedStatus === 'invisible') {
        socket.emit('user:online', { userId, username, status: savedStatus })
      } else {
        io.emit('user:online', { userId, username, status: savedStatus })
      }
    }

    const db2 = getDb()
    const onlineUserIds = Array.from(userStatuses.keys()).filter(
      (uid) => userStatuses.get(uid) !== 'invisible',
    )
    const usernameMap = new Map<string, string>()
    if (onlineUserIds.length > 0) {
      const placeholders = onlineUserIds.map(() => '?').join(',')
      const userRows = db2
        .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
        .all(...onlineUserIds) as { id: string; username: string }[]
      for (const row of userRows) {
        usernameMap.set(row.id, row.username)
      }
    }
    const onlineList: Record<
      string,
      { username: string; status: UserStatus; activity?: UserActivity | null }
    > = {}
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
    } catch {
      /* ignore */
    }
  })

  socket.on('user:status', (payload: unknown) => {
    if (!userId || !isRecord(payload)) return
    if (!checkSocketRateLimit(socket, 'user:status', 10, 10_000)) return
    const { status_text, status_emoji, status_sticker_id } = payload
    const status = payload.status as UserStatus | undefined
    if (status !== undefined && !STATUSES.includes(status)) return
    if (
      !optionalString(status_text, 128) ||
      !optionalString(status_emoji, 64) ||
      !optionalString(status_sticker_id, 128)
    ) {
      return
    }
    const db = getDb()
    const prevStatus = userStatuses.get(userId)
    if (status) {
      userStatuses.set(userId, status)
      try {
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId)
      } catch {
        /* ignore */
      }
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
      if (
        status_text !== undefined ||
        status_emoji !== undefined ||
        status_sticker_id !== undefined
      ) {
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

  socket.on('user:activity', (payload: unknown) => {
    if (!userId || !isRecord(payload)) return
    if (!checkSocketRateLimit(socket, 'user:activity', 10, 10_000)) return
    const activity = sanitizeActivity(payload.activity)
    if (activity === undefined) return
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

    const sockets = userSockets.get(userId)
    sockets?.delete(socket.id)
    const lastSocket = !sockets || sockets.size === 0
    if (lastSocket) userSockets.delete(userId)

    // Calls belong to the user, not to one tab/device: closing a second
    // window must not hang up a call that is running in the first.
    if (lastSocket) endCallsForDepartedUser(io, userId)

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

function endCallsForDepartedUser(io: Server, userId: string): void {
  for (const [dmChannelId, call] of dmCalls) {
    if (call.callerId === userId || call.calleeId === userId) {
      const otherUserId = call.callerId === userId ? call.calleeId : call.callerId
      io.to(`user:${otherUserId}`).emit('dm:call:ended', { dmChannelId })
      dmCalls.delete(dmChannelId)
    }
  }

  // Only calls the user actually joined are affected. A group member who never
  // picked up going offline must not end the call for everyone else; the call
  // only ends once nobody is left in it.
  for (const [channelId, call] of groupDMCalls) {
    if (!call.participants.has(userId)) continue
    call.participants.delete(userId)
    if (call.participants.size > 0) continue
    groupDMCalls.delete(channelId)
    const members = getDb()
      .prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ?')
      .all(channelId) as { user_id: string }[]
    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:ended', { channelId })
    }
  }
}
