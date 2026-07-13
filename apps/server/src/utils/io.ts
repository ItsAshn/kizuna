import type { Context } from 'hono'
import type { Server as IoServer } from 'socket.io'
import { getEligibleNotifyUserIds } from '../middleware/auth'

export function getIo(c: Context): IoServer | undefined {
  return c.get('io' as never) as IoServer | undefined
}

export function emitIo(c: Context, event: string, data: unknown): void {
  try {
    getIo(c)?.emit(event, data)
  } catch { /* best-effort */ }
}

export function emitToRoom(c: Context, room: string, event: string, data: unknown): void {
  try {
    getIo(c)?.to(room).emit(event, data)
  } catch { /* best-effort */ }
}

// Channel events also fan out to eligible members' personal rooms (skipping
// the actor, muted users, and anyone who can't view the channel) so clients
// not actively viewing the channel can still be notified.
export function emitToChannel(c: Context, channelId: string, event: string, data: unknown, actorUserId: string): void {
  try {
    const io = getIo(c)
    if (!io) return
    io.to(channelId).emit(event, data)
    for (const uid of getEligibleNotifyUserIds(channelId, actorUserId)) {
      io.to(`user:${uid}`).emit(event, data)
    }
  } catch { /* best-effort */ }
}
