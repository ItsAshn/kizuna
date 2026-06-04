import type { Context, Next } from 'hono'
import jwt from 'jsonwebtoken'
import { getDb } from '../db'
import type { AuthUser } from '../types'

export type { AuthUser }

export interface JwtPayload {
  userId: string
  username: string
}

export function signToken(payload: JwtPayload): string {
  const secret = process.env.JWT_SECRET || ''
  return jwt.sign(payload, secret, { expiresIn: '30d' })
}

export function verifyToken(token: string): JwtPayload {
  const secret = process.env.JWT_SECRET || ''
  return jwt.verify(token, secret) as JwtPayload
}

export function getUserInfo(userId: string): AuthUser | null {
  const db = getDb()
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId) as { id: string; username: string; display_name: string } | undefined
  if (!user) return null
  const member = db.prepare('SELECT role FROM server_members WHERE user_id = ?').get(userId) as { role: string } | undefined
  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: (member?.role as 'admin' | 'member') || 'member',
  }
}

export function getUserPermissions(userId: string): { role: string; permissions: Record<string, boolean> } | null {
  const db = getDb()
  const member = db.prepare(`
    SELECT sm.role, sm.custom_role_id, r.permissions
    FROM server_members sm
    LEFT JOIN roles r ON sm.custom_role_id = r.id
    WHERE sm.user_id = ?
  `).get(userId) as { role: string; custom_role_id: string | null; permissions: string | null } | undefined

  if (!member) return null

  let permissions: Record<string, boolean> = {
    send_messages: true,
  }
  if (member.role === 'admin') {
    permissions = {
      send_messages: true,
      manage_channels: true,
      delete_messages: true,
      kick_members: true,
      manage_invites: true,
    }
  } else if (member.permissions) {
    try {
      permissions = { send_messages: true, ...JSON.parse(member.permissions) }
    } catch {
      permissions = { send_messages: true }
    }
  }

  return { role: member.role, permissions }
}

export function hasPermission(
  userInfo: { role: string; permissions: Record<string, boolean> },
  permission: string,
): boolean {
  if (userInfo.role === 'admin') return true
  return userInfo.permissions[permission] === true
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401)
  }

  const token = authHeader.slice(7)
  try {
    const payload = verifyToken(token)
    const userInfo = getUserInfo(payload.userId)
    if (!userInfo) {
      return c.json({ error: 'User not found' }, 401)
    }
    c.set('auth' as never, userInfo as never)
    await next()
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
}

export async function adminMiddleware(c: Context, next: Next): Promise<Response | void> {
  const user = c.get('auth' as never) as AuthUser | undefined
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required' }, 403)
  }
  await next()
}

export function authOptional(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    try {
      const payload = verifyToken(token)
      const userInfo = getUserInfo(payload.userId)
      if (userInfo) {
        c.set('auth' as never, userInfo as never)
      }
    } catch {
      // Token invalid — continue without auth
    }
  }
  return next()
}
