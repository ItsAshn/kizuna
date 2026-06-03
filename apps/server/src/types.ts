import type { Context } from 'hono'
import type { Server as IoServer } from 'socket.io'

export interface AuthUser {
  userId: string
  username: string
  displayName: string
  role: 'admin' | 'member'
}

export interface HonoEnv {
  Variables: {
    auth: AuthUser
    io: IoServer
  }
}

export type AppContext = Context<HonoEnv>
