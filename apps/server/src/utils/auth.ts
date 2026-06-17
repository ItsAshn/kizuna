import type { Context } from 'hono';
import type { HonoEnv, AuthUser } from '../types';

type Ctx = Context<HonoEnv>;

export function getAuth(c: Ctx): AuthUser | null {
  return c.get('auth') ?? null;
}
