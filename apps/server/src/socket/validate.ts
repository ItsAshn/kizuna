import type { Socket } from 'socket.io'
import { createLogger } from '../utils/logger'

const log = createLogger('socket')

// Socket.IO runs listeners inside process.nextTick, so a synchronous throw
// (destructuring a null payload, an FK violation) or a rejected promise from
// an async handler escaped to the process and took the whole server down.
// Wrapping every listener at registration time closes that class of crash
// for all current and future handlers.
export function hardenSocket(socket: Socket): void {
  const originalOn = socket.on.bind(socket)
  socket.on = ((event: string, listener: (...args: unknown[]) => unknown) => {
    const wrapped = (...args: unknown[]) => {
      try {
        const result = listener(...args)
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          ;(result as Promise<unknown>).catch((err) => report(socket, event, err, args))
        }
      } catch (err) {
        report(socket, event, err, args)
      }
    }
    return originalOn(event, wrapped)
  }) as typeof socket.on
}

function report(socket: Socket, event: string, err: unknown, args: unknown[]): void {
  log.error(
    `handler "${event}" failed for user ${socket.data.userId ?? '?'}:`,
    err instanceof Error ? err.message : err,
  )
  const ack = args[args.length - 1]
  if (typeof ack === 'function') {
    try {
      ack({ error: 'Internal error' })
    } catch {
      /* ack already sent */
    }
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isId(v: unknown, max = 128): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}

export function optionalId(v: unknown, max = 128): v is string | undefined | null {
  return v === undefined || v === null || isId(v, max)
}

export function isText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max
}

// Clients address rooms by id. Personal rooms (user:/dm:/group-dm:) are only
// ever joined by the server for the socket's own user, never on request.
export function isReservedRoom(id: string): boolean {
  return /^(user|dm|group-dm):/.test(id)
}
