import type { Context } from 'hono';
import type { Server as IoServer } from 'socket.io';

export interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  isHost: boolean;
}

export interface HonoEnv {
  Variables: {
    auth: AuthUser;
    io: IoServer;
  };
}

export type AppContext = Context<HonoEnv>;

export type AppHono = import('hono').Hono<HonoEnv>;
