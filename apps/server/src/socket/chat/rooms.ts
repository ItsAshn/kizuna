import type { Server, Socket } from 'socket.io'
import { getDb } from '../../db'
import { getSocketUserId } from './helpers'

export function registerRoomHandlers(_io: Server, socket: Socket): void {
  const NOTIFICATION_ROOM = '__notifications__'
  const userId = getSocketUserId(socket)

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

  socket.on('channel:join', (channelId: string) => {
    socket.join(channelId)
    socket.data.currentChannel = channelId
  })

  socket.on('channel:leave', (channelId: string) => {
    socket.leave(channelId)
  })

  socket.on('thread:join', (threadId: string) => {
    socket.join(threadId)
  })

  socket.on('thread:leave', (threadId: string) => {
    socket.leave(threadId)
  })
}
