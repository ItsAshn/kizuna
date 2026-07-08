import type { Context } from 'hono'
import type { Server as IoServer } from 'socket.io'

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

// Channel events also go to the __notifications__ room so clients not in the
// channel can update unread state.
export function emitToChannel(c: Context, channelId: string, event: string, data: unknown): void {
  try {
    getIo(c)?.to(channelId).to('__notifications__').emit(event, data)
  } catch { /* best-effort */ }
}
