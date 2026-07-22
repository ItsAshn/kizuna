import type { Context } from 'hono'
import type { Server as IoServer } from 'socket.io'
import { getEligibleNotifyUserIds } from '../middleware/auth'

export function getIo(c: Context): IoServer | undefined {
  return c.get('io' as never) as IoServer | undefined
}

export function emitIo(c: Context, event: string, data: unknown): void {
  try {
    const io = getIo(c)
    if (!io) {
      console.warn(`[emitIo] Socket.IO instance not available for event: ${event}`)
      return
    }
    io.emit(event, data)
  } catch (err) {
    console.warn(`[emitIo] Failed to emit "${event}":`, err)
  }
}

export function emitToRoom(c: Context, room: string, event: string, data: unknown): void {
  try {
    const io = getIo(c)
    if (!io) {
      console.warn(`[emitToRoom] Socket.IO instance not available for event: ${event}`)
      return
    }
    io.to(room).emit(event, data)
  } catch (err) {
    console.warn(`[emitToRoom] Failed to emit "${event}" to room "${room}":`, err)
  }
}

// Channel events also fan out to eligible members' personal rooms (skipping
// the actor, muted users, and anyone who can't view the channel) so clients
// not actively viewing the channel can still be notified.
export function emitToChannel(c: Context, channelId: string, event: string, data: unknown, actorUserId: string): void {
  try {
    const io = getIo(c)
    if (!io) {
      console.warn(`[emitToChannel] Socket.IO instance not available for event: ${event}`)
      return
    }
    io.to(channelId).emit(event, data)
    for (const uid of getEligibleNotifyUserIds(channelId, actorUserId)) {
      io.to(`user:${uid}`).emit(event, data)
    }
  } catch (err) {
    console.warn(`[emitToChannel] Failed to emit "${event}" to channel "${channelId}":`, err)
  }
}
