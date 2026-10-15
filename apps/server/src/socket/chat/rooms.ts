import type { Server, Socket } from 'socket.io'
import { getDb } from '../../db'
import { getSocketUserId, resolveAccessibleRoom } from './helpers'
import { canViewChannel } from '../../middleware/auth'
import { isId, isReservedRoom } from '../validate'

export function registerRoomHandlers(_io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)

  socket.on('channel:mute:sync', () => {
    if (!userId) return
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT channel_id, muted_until FROM channel_mutes
       WHERE user_id = ? AND (muted_until IS NULL OR muted_until > unixepoch())`,
      )
      .all(userId) as { channel_id: string; muted_until: number | null }[]

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
      socket.data.userId = userId
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

  socket.on('channel:join', (channelId: unknown) => {
    if (!resolveAccessibleRoom(userId, channelId)) return
    socket.join(channelId as string)
    socket.data.currentChannel = channelId
  })

  socket.on('channel:leave', (channelId: unknown) => {
    if (!isId(channelId) || isReservedRoom(channelId)) return
    socket.leave(channelId)
  })

  socket.on('thread:join', (threadId: unknown) => {
    if (!isId(threadId)) return
    const thread = getDb().prepare('SELECT channel_id FROM threads WHERE id = ?').get(threadId) as
      | { channel_id: string }
      | undefined
    if (!thread || !canViewChannel(userId, thread.channel_id)) return
    socket.join(threadId)
  })

  socket.on('thread:leave', (threadId: unknown) => {
    if (!isId(threadId) || isReservedRoom(threadId)) return
    socket.leave(threadId)
  })
}
