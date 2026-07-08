import type { Context } from 'hono'
import type { AuthUser } from '../types'

// The authenticated user set by authMiddleware — only call on routes behind it.
export function getAuth(c: Context): AuthUser {
  return c.get('auth' as never) as AuthUser
}
