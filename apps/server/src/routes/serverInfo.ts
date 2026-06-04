import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import jwt from 'jsonwebtoken'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, getUserInfo } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const serverInfoRoutes = new Hono()

function getServerInfo() {
  const db = getDb()
  const name = db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get() as { value: string } | undefined
  const description = db.prepare("SELECT value FROM server_settings WHERE key = 'server_description'").get() as { value: string } | undefined
  const icon = db.prepare("SELECT value FROM server_settings WHERE key = 'server_icon'").get() as { value: string } | undefined
  const serverUrl = db.prepare("SELECT value FROM server_settings WHERE key = 'server_url'").get() as { value: string } | undefined

  return {
    name: name?.value || process.env.SERVER_NAME || 'Kizuna Server',
    description: description?.value || process.env.SERVER_DESCRIPTION || '',
    passwordProtected: !!(process.env.SERVER_PASSWORD && process.env.SERVER_PASSWORD.trim()),
    icon: icon?.value || null,
    serverUrl: serverUrl?.value || null,
  }
}

function generateInviteCode(serverUrl: string): string {
  const encodedUrl = Buffer.from(serverUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const randomPart = uuidv4().replace(/-/g, '').substring(0, 6)
  return `${encodedUrl}.${randomPart}`.toUpperCase()
}

function decodeServerUrl(code: string): string {
  const [encodedUrl] = code.split('.')
  try {
    return Buffer.from(encodedUrl.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  } catch {
    throw new Error('Invalid invite code')
  }
}

serverInfoRoutes.get('/info', (c) => {
  return c.json(getServerInfo())
})

serverInfoRoutes.patch('/settings', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (user.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)

  const body = await c.req.json() as { name?: string; icon?: string | null }
  const { name, icon } = body
  const db = getDb()

  if (name !== undefined) {
    if (!name?.trim()) return c.json({ error: 'name cannot be empty' }, 400)
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_name', ?)").run(name.trim())
  }
  if (icon !== undefined) {
    if (icon !== null && typeof icon !== 'string') {
      return c.json({ error: 'icon must be a string or null' }, 400)
    }
    if (icon === null) {
      db.prepare("DELETE FROM server_settings WHERE key = 'server_icon'").run()
    } else {
      db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('server_icon', ?)").run(icon)
    }
  }

  return c.json(getServerInfo())
})

serverInfoRoutes.post('/announce', authMiddleware, async (c) => {
  const body = await c.req.json() as { title: string; body: string }
  const { title, body: announceBody } = body
  if (!title || !announceBody) {
    return c.json({ error: 'title and body are required' }, 400)
  }

  try {
    const io: any = c.get('io' as never)
    if (!io) return c.json({ error: 'Socket.IO not available' }, 500)
    io.to('__notifications__').emit('server:announce', { title, body: announceBody })
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Socket.IO not available' }, 500)
  }
})

serverInfoRoutes.post('/invites', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_invites')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = await c.req.json() as { maxUses?: number | null; expiresInHours?: number | null }
  const { maxUses, expiresInHours } = body
  const db = getDb()

  let serverUrl = process.env.SERVER_URL || ''
  if (!serverUrl) {
    const publicAddress = process.env.PUBLIC_ADDRESS || 'localhost'
    const port = process.env.SERVER_PORT || '5000'
    serverUrl = `http://${publicAddress}:${port}`
  }

  const max = maxUses && maxUses > 0 ? Math.round(maxUses) : null
  const expiresAt = expiresInHours && expiresInHours > 0
    ? Math.floor(Date.now() / 1000) + Math.round(expiresInHours * 3600)
    : null

  const code = generateInviteCode(serverUrl)

  db.prepare(
    'INSERT INTO invite_codes (code, created_by, max_uses, uses, expires_at) VALUES (?, ?, ?, 0, ?)'
  ).run(code, user.userId, max, expiresAt)

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any
  return c.json({
    code: invite.code,
    created_by: invite.created_by,
    max_uses: invite.max_uses,
    uses: invite.uses,
    expires_at: invite.expires_at ? invite.expires_at * 1000 : null,
    created_at: invite.created_at ? invite.created_at * 1000 : undefined,
  }, 201)
})

serverInfoRoutes.get('/invites', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_invites')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const invites = db.prepare(
    `SELECT * FROM invite_codes
     WHERE (expires_at IS NULL OR expires_at > ?)
       AND (max_uses IS NULL OR uses < max_uses)
     ORDER BY created_at DESC`
  ).all(now) as any[]
  const result = invites.map((inv) => ({
    code: inv.code,
    created_by: inv.created_by,
    max_uses: inv.max_uses,
    uses: inv.uses,
    expires_at: inv.expires_at ? inv.expires_at * 1000 : null,
    created_at: inv.created_at ? inv.created_at * 1000 : undefined,
  }))
  return c.json({ invites: result })
})

serverInfoRoutes.delete('/invites/:code', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_invites')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const code = (c.req.param('code') || '').toUpperCase()
  const db = getDb()
  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code)
  if (!invite) return c.json({ error: 'Invite not found' }, 404)
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code)
  return c.json({ ok: true })
})

serverInfoRoutes.post('/join/:code', async (c) => {
  const code = (c.req.param('code') || '').toUpperCase()
  const db = getDb()
  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any
  if (!invite) return c.json({ error: 'Invalid invite code' }, 404)

  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    return c.json({ error: 'Invite has reached maximum uses' }, 400)
  }

  if (invite.expires_at !== null && invite.expires_at * 1000 < Date.now()) {
    return c.json({ error: 'Invite has expired' }, 400)
  }

  const authHeader = c.req.header('Authorization')
  let userId: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const payload = jwt.verify(token, process.env.JWT_SECRET || '') as { userId: string }
      userId = payload.userId
    } catch {
      // Invalid token — user must register
    }
  }

  if (userId) {
    const existing = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(userId)
    if (existing) return c.json({ ok: true, alreadyMember: true })

    db.prepare('INSERT OR REPLACE INTO server_members (user_id, role) VALUES (?, ?)').run(userId, 'member')
    db.prepare('UPDATE invite_codes SET uses = uses + 1 WHERE code = ?').run(code)
    return c.json({ ok: true, alreadyMember: false })
  }

  return c.json({ ok: true, alreadyMember: false, needsRegistration: true })
})


serverInfoRoutes.get('/resolve/:code', (c) => {
  const code = (c.req.param('code') || '').toUpperCase()
  const db = getDb()
  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as any
  if (!invite) return c.json({ error: 'Invalid invite code' }, 404)

  try {
    const serverUrl = decodeServerUrl(code)
    const info = getServerInfo()
    return c.json({
      serverUrl,
      name: info.name,
      description: info.description,
    })
  } catch {
    return c.json({ error: 'Invalid invite code' }, 400)
  }
})

serverInfoRoutes.patch('/members/:userId/role', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (user.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)

  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)
  const body = await c.req.json() as { role: 'admin' | 'member' }
  const { role } = body
  if (!['admin', 'member'].includes(role)) return c.json({ error: 'Invalid role' }, 400)

  const db = getDb()
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(targetUserId)
  if (!member) return c.json({ error: 'Member not found' }, 404)

  db.prepare('UPDATE server_members SET role = ? WHERE user_id = ?').run(role, targetUserId)
  return c.json({ ok: true })
})

serverInfoRoutes.delete('/members/:userId', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'kick_members')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)
  if (targetUserId === user.userId) return c.json({ error: 'Cannot kick yourself' }, 400)

  const db = getDb()
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(targetUserId)
  if (!member) return c.json({ error: 'Member not found' }, 404)

  const targetInfo = getUserInfo(targetUserId)
  if (targetInfo && targetInfo.role === 'admin' && user.role !== 'admin') {
    return c.json({ error: 'Cannot kick an admin' }, 403)
  }

  db.prepare('DELETE FROM server_members WHERE user_id = ?').run(targetUserId)
  return c.json({ ok: true })
})

serverInfoRoutes.patch('/members/:userId/custom-role', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (user.role !== 'admin') return c.json({ error: 'Admin access required' }, 403)

  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)
  const body = await c.req.json() as { roleId: string | null }
  const { roleId } = body

  const db = getDb()
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(targetUserId)
  if (!member) return c.json({ error: 'Member not found' }, 404)

  if (roleId !== null) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)
    if (!role) return c.json({ error: 'Role not found' }, 404)
  }

  db.prepare('UPDATE server_members SET custom_role_id = ? WHERE user_id = ?').run(roleId, targetUserId)
  return c.json({ ok: true })
})

export default serverInfoRoutes
