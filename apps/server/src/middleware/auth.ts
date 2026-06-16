import type { Context, Next } from 'hono'
import jwt from 'jsonwebtoken'
import { getDb } from '../db'
import type { AuthUser } from '../types'

export type { AuthUser }

export interface JwtPayload {
  userId: string
  username: string
  tokenId?: string
  iat?: number
}

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET is not set. Authentication cannot function.')
  }
  if (secret === 'change_this_to_a_long_random_secret') {
    throw new Error('JWT_SECRET is using the default placeholder. Generate one with: openssl rand -hex 64')
  }
  return secret
}

export function signToken(payload: JwtPayload): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign({ ...payload, iat: now }, getJwtSecret(), { expiresIn: '30d' })
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getJwtSecret()) as JwtPayload
}

export function isUserAdmin(userId: string): boolean {
  const db = getDb()
  const row = db.prepare(`
    SELECT 1 FROM member_roles mr
    JOIN roles r ON mr.role_id = r.id
    WHERE mr.user_id = ? AND r.is_admin = 1
    UNION ALL
    SELECT 1 FROM server_members sm
    JOIN roles r ON sm.custom_role_id = r.id
    WHERE sm.user_id = ? AND sm.custom_role_id IS NOT NULL AND r.is_admin = 1
      AND NOT EXISTS (SELECT 1 FROM member_roles mr2 WHERE mr2.user_id = sm.user_id AND mr2.role_id = sm.custom_role_id)
  `).get(userId, userId)
  return !!row
}

export function isUserHost(userId: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT 1 FROM server_members WHERE user_id = ? AND is_host = 1').get(userId)
  return !!row
}

export function assignDefaultRoles(userId: string): void {
  const db = getDb()
  const defaultRoles = db.prepare(
    'SELECT id FROM roles WHERE default_on_join = 1'
  ).all() as { id: string }[]
  const stmt = db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)')
  for (const role of defaultRoles) {
    stmt.run(userId, role.id)
  }
}

export function getUserInfo(userId: string): AuthUser | null {
  const db = getDb()
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(userId) as { id: string; username: string; display_name: string } | undefined
  if (!user) return null
  return {
    userId: user.id,
    username: user.username,
    displayName: user.display_name,
    role: isUserAdmin(userId) ? 'admin' : 'member',
    isHost: isUserHost(userId),
  }
}

export function getUserPermissions(userId: string): { role: string; permissions: Record<string, boolean> } | null {
  const db = getDb()
  const member = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(userId)
  if (!member) return null

  const userIsAdmin = isUserAdmin(userId)

  if (userIsAdmin) {
    return {
      role: 'admin',
      permissions: {
        send_messages: true,
        send_dm_messages: true,
        add_reactions: true,
        upload_attachments: true,
        delete_messages: true,
        manage_channels: true,
        manage_roles: true,
        kick_members: true,
        manage_invites: true,
        use_voice: true,
        initiate_dm_calls: true,
      },
    }
  }

  let permissions: Record<string, boolean> = {
    send_messages: true,
    send_dm_messages: true,
    add_reactions: true,
    upload_attachments: true,
    use_voice: true,
    initiate_dm_calls: true,
  }

  const roles = db.prepare(`
    SELECT r.permissions, r.position
    FROM member_roles mr
    JOIN roles r ON mr.role_id = r.id
    WHERE mr.user_id = ?
    UNION ALL
    SELECT r.permissions, r.position
    FROM server_members sm
    JOIN roles r ON sm.custom_role_id = r.id
    WHERE sm.user_id = ? AND sm.custom_role_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM member_roles mr2 WHERE mr2.user_id = sm.user_id AND mr2.role_id = sm.custom_role_id)
    ORDER BY position ASC
  `).all(userId, userId) as { permissions: string }[]

  for (const role of roles) {
    try {
      const rolePerms = JSON.parse(role.permissions || '{}')
      for (const [key, value] of Object.entries(rolePerms)) {
        if (value === true) permissions[key] = true
      }
    } catch { /* skip malformed JSON */ }
  }

  return { role: 'member', permissions }
}

export function hasPermission(
  userInfo: { role: string; permissions: Record<string, boolean> },
  permission: string,
): boolean {
  if (userInfo.role === 'admin') return true
  return userInfo.permissions[permission] === true
}

export function hasPermissionForUser(
  userId: string,
  permission: string,
): boolean {
  if (isUserAdmin(userId)) return true
  const info = getUserPermissions(userId)
  if (!info) return false
  return info.permissions[permission] === true
}

export function canWriteToChannel(userId: string, channelId: string): boolean {
  const db = getDb()
  const channel = db.prepare('SELECT locked, write_role_id FROM channels WHERE id = ?').get(channelId) as { locked: number; write_role_id: string | null } | undefined
  if (!channel || !channel.locked) return true

  const isMember = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(userId)
  if (!isMember) return false
  if (isUserAdmin(userId)) return true

  if (!channel.write_role_id) return false

  const hasRole = db.prepare(`
    SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = ?
    UNION ALL
    SELECT 1 FROM server_members WHERE user_id = ? AND custom_role_id = ? AND custom_role_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = ? AND mr.role_id = ?)
  `).get(userId, channel.write_role_id, userId, channel.write_role_id, userId, channel.write_role_id)

  return !!hasRole
}

export function getUserChannelPermissions(userId: string, channelId: string): { can_write: boolean; locked: boolean; write_role_id: string | null; write_role_name: string | null } {
  const db = getDb()
  const channel = db.prepare('SELECT locked, write_role_id FROM channels WHERE id = ?').get(channelId) as { locked: number; write_role_id: string | null } | undefined
  if (!channel || !channel.locked) return { can_write: true, locked: false, write_role_id: null, write_role_name: null }

  const isMember = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(userId)
  if (!isMember) return { can_write: false, locked: true, write_role_id: channel.write_role_id, write_role_name: null }
  if (isUserAdmin(userId)) return { can_write: true, locked: true, write_role_id: channel.write_role_id, write_role_name: null }

  let writeRoleName: string | null = null
  if (channel.write_role_id) {
    const role = db.prepare('SELECT name FROM roles WHERE id = ?').get(channel.write_role_id) as { name: string } | undefined
    writeRoleName = role?.name ?? null
  }

  if (!channel.write_role_id) return { can_write: false, locked: true, write_role_id: channel.write_role_id, write_role_name: writeRoleName }

  const hasRole = db.prepare(`
    SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = ?
    UNION ALL
    SELECT 1 FROM server_members WHERE user_id = ? AND custom_role_id = ? AND custom_role_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = ? AND mr.role_id = ?)
  `).get(userId, channel.write_role_id, userId, channel.write_role_id, userId, channel.write_role_id)

  return { can_write: !!hasRole, locked: true, write_role_id: channel.write_role_id, write_role_name: writeRoleName }
}

export function getUserChannelPermission(userId: string, channelId: string, permission: string): boolean {
  if (isUserAdmin(userId)) return true

  const basePerms = getUserPermissions(userId)
  if (!basePerms) return false

  const baseValue = basePerms.permissions[permission] === true

  const db = getDb()
  const overrides = db.prepare(`
    SELECT cro.allow_permissions, cro.deny_permissions
    FROM channel_role_overrides cro
    JOIN member_roles mr ON mr.role_id = cro.role_id AND mr.user_id = ?
    JOIN roles r ON r.id = cro.role_id
    WHERE cro.channel_id = ?
    ORDER BY r.position ASC
  `).all(userId, channelId) as { allow_permissions: string; deny_permissions: string }[]

  let resolved = baseValue
  for (const override of overrides) {
    try {
      const allow = JSON.parse(override.allow_permissions || '{}')
      const deny = JSON.parse(override.deny_permissions || '{}')
      if (deny[permission] === true) resolved = false
      if (allow[permission] === true) resolved = true
    } catch { /* skip malformed JSON */ }
  }

  return resolved
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  let token: string | undefined

  const cookieHeader = c.req.header('Cookie')
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)kizuna_token=([^;]*)/)
    if (match) token = match[1]
  }

  if (!token) {
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7)
    }
  }

  if (!token) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401)
  }

  try {
    const payload = verifyToken(token)
    const userInfo = getUserInfo(payload.userId)
    if (!userInfo) {
      return c.json({ error: 'User not found' }, 401)
    }

    const db = getDb()
    const row = db.prepare('SELECT token_invalidated_at FROM users WHERE id = ?').get(payload.userId) as { token_invalidated_at: number | null } | undefined
    if (row?.token_invalidated_at && payload.iat && row.token_invalidated_at > payload.iat) {
      return c.json({ error: 'Token has been revoked' }, 401)
    }

    if (payload.tokenId) {
      const session = db.prepare('SELECT revoked_at FROM sessions WHERE token_id = ?').get(payload.tokenId) as { revoked_at: number | null } | undefined
      if (session?.revoked_at) {
        return c.json({ error: 'Token has been revoked' }, 401)
      }
    }

    c.set('auth' as never, userInfo as never)
    await next()
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
}

export async function adminMiddleware(c: Context, next: Next): Promise<Response | void> {
  const user = c.get('auth' as never) as AuthUser | undefined
  if (!user || !isUserAdmin(user.userId)) {
    return c.json({ error: 'Admin access required' }, 403)
  }
  await next()
}

export function authOptional(c: Context, next: Next): Promise<void> {
  let token: string | undefined

  const cookieHeader = c.req.header('Cookie')
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)kizuna_token=([^;]*)/)
    if (match) token = match[1]
  }

  if (!token) {
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7)
    }
  }

  if (token) {
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
