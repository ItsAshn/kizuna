import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, getUserInfo, isUserAdmin, isUserHost, assignDefaultRoles } from '../middleware/auth'
import { getAllPeers } from '../socket/voiceHandler'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

function getMemberById(userId: string) {
  const db = getDb()
  const user = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.public_key, u.last_seen_at, u.reset_requested_at, sm.is_host
    FROM users u
    LEFT JOIN server_members sm ON sm.user_id = u.id
    WHERE u.id = ?
  `).get(userId) as any
  if (!user) return null

  const memberRoles = db.prepare(`
    SELECT mr.user_id, r.id, r.name, r.color, r.permissions, r.is_admin, r.position, r.hoist
    FROM member_roles mr
    JOIN roles r ON mr.role_id = r.id
    WHERE mr.user_id = ?
    ORDER BY r.position ASC
  `).all(userId) as { user_id: string; id: string; name: string; color: string; permissions: string; is_admin: number; position: number; hoist: number }[]

  const rolesByUser: { id: string; name: string; color: string; permissions: Record<string, boolean>; is_admin: boolean; position: number; hoist: boolean }[] = []
  for (const row of memberRoles) {
    rolesByUser.push({
      id: row.id,
      name: row.name,
      color: row.color,
      permissions: (() => { try { return JSON.parse(row.permissions || '{}') } catch { return {} } })(),
      is_admin: row.is_admin === 1,
      position: row.position ?? 0,
      hoist: row.hoist === 1,
    })
  }

  const legacyRoles = db.prepare(`
    SELECT r.id, r.name, r.color, r.permissions, r.is_admin, r.position, r.hoist
    FROM server_members sm
    JOIN roles r ON sm.custom_role_id = r.id
    WHERE sm.user_id = ?
      AND sm.custom_role_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = sm.user_id AND mr.role_id = sm.custom_role_id)
  `).all(userId) as { id: string; name: string; color: string; permissions: string; is_admin: number; position: number; hoist: number }[]

  for (const row of legacyRoles) {
    if (!rolesByUser.some(r => r.id === row.id)) {
      rolesByUser.push({
        id: row.id,
        name: row.name,
        color: row.color,
        permissions: (() => { try { return JSON.parse(row.permissions || '{}') } catch { return {} } })(),
        is_admin: row.is_admin === 1,
        position: row.position ?? 0,
        hoist: row.hoist === 1,
      })
    }
  }

  const isAdmin = rolesByUser.some(r => r.is_admin)
  const highestRole = rolesByUser.length > 0 ? rolesByUser[rolesByUser.length - 1] : null
  const hoistedRole = [...rolesByUser].reverse().find(r => r.hoist) || null
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar: user.avatar,
    last_seen_at: user.last_seen_at ? user.last_seen_at * 1000 : null,
    role: isAdmin ? 'admin' : 'member',
    is_host: user.is_host === 1,
    custom_roles: rolesByUser,
    custom_role_id: highestRole?.id ?? null,
    custom_role_name: highestRole?.name ?? null,
    custom_role_color: highestRole?.color ?? null,
    hoist_role_id: hoistedRole?.id ?? null,
    hoist_role_name: hoistedRole?.name ?? null,
    hoist_role_color: hoistedRole?.color ?? null,
  }
}

const serverInfoRoutes = new Hono()

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const BACKGROUNDS_DIR = path.join(UPLOADS_DIR, 'backgrounds')
const MAX_BACKGROUND_SIZE = 10 * 1024 * 1024

if (!fs.existsSync(BACKGROUNDS_DIR)) {
  fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true })
}

function getServerInfo() {
  const db = getDb()
  const name = db.prepare("SELECT value FROM server_settings WHERE key = 'server_name'").get() as { value: string } | undefined
  const description = db.prepare("SELECT value FROM server_settings WHERE key = 'server_description'").get() as { value: string } | undefined
  const icon = db.prepare("SELECT value FROM server_settings WHERE key = 'server_icon'").get() as { value: string } | undefined
  const serverUrl = db.prepare("SELECT value FROM server_settings WHERE key = 'server_url'").get() as { value: string } | undefined
  const backgroundBlur = db.prepare("SELECT value FROM server_settings WHERE key = 'background_blur'").get() as { value: string } | undefined
  const customCss = db.prepare("SELECT value FROM server_settings WHERE key = 'custom_css'").get() as { value: string } | undefined
  const voiceBitrateRow = db.prepare("SELECT value FROM server_settings WHERE key = 'voice_bitrate_kbps'").get() as { value: string } | undefined

  let hasBackground = false
  try {
    const bgFiles = fs.readdirSync(BACKGROUNDS_DIR)
    hasBackground = bgFiles.length > 0
  } catch {}

  return {
    name: name?.value || process.env.SERVER_NAME || 'Kizuna Server',
    description: description?.value || process.env.SERVER_DESCRIPTION || '',
    passwordProtected: !!(process.env.SERVER_PASSWORD && process.env.SERVER_PASSWORD.trim()),
    icon: icon?.value || null,
    serverUrl: serverUrl?.value || process.env.SERVER_URL || null,
    hasBackground,
    backgroundBlur: backgroundBlur?.value ? parseInt(backgroundBlur.value, 10) : 0,
    customCss: customCss?.value || null,
    voiceBitrateKbps: (() => {
      if (voiceBitrateRow?.value) {
        const p = parseInt(voiceBitrateRow.value, 10)
        if (!isNaN(p) && p >= 8 && p <= 512) return p
      }
      return getEnvBitrate()
    })(),
    gifsEnabled: true,
  }
}

function getEnvBitrate(): number {
  const envBitrate = parseInt(process.env.AUDIO_BITRATE_KBPS || '', 10)
  if (!isNaN(envBitrate) && envBitrate >= 8 && envBitrate <= 512) return envBitrate
  return 64
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

serverInfoRoutes.get('/admins', (c) => {
  const db = getDb()
  const admins = db.prepare(`
    SELECT u.username, u.display_name
    FROM users u
    INNER JOIN server_members sm ON sm.user_id = u.id
    WHERE sm.role = 'admin'
    ORDER BY u.username
  `).all() as { username: string; display_name: string }[]

  return c.json({ admins })
})

serverInfoRoutes.patch('/settings', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const body = await c.req.json() as { name?: string; icon?: string | null; background_blur?: number; custom_css?: string | null; voice_bitrate_kbps?: number }
  const { name, icon, background_blur, custom_css, voice_bitrate_kbps } = body
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
  if (background_blur !== undefined) {
    const blur = Math.max(0, Math.min(20, background_blur))
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('background_blur', ?)").run(String(blur))
  }
  if (custom_css !== undefined) {
    if (custom_css !== null && typeof custom_css !== 'string') {
      return c.json({ error: 'custom_css must be a string or null' }, 400)
    }
    if (custom_css !== null && custom_css.length > 50000) {
      return c.json({ error: 'custom_css must be under 50000 characters' }, 400)
    }
    if (custom_css !== null && (custom_css.includes('url(') || custom_css.includes('@import'))) {
      return c.json({ error: 'custom_css may not contain url() or @import directives' }, 400)
    }
    if (custom_css === null) {
      db.prepare("DELETE FROM server_settings WHERE key = 'custom_css'").run()
    } else {
      db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('custom_css', ?)").run(custom_css)
    }
  }
  if (voice_bitrate_kbps !== undefined) {
    const kbps = Math.max(8, Math.min(512, Math.round(voice_bitrate_kbps)))
    db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('voice_bitrate_kbps', ?)").run(String(kbps))
    const bps = kbps * 1000
    for (const peer of getAllPeers()) {
      for (const [, transport] of peer.transports) {
        transport.setMaxIncomingBitrate(bps).catch(() => {})
      }
    }
    const io: any = c.get('io' as never)
    if (io) {
      io.emit('server:voiceBitrateChanged', { voiceBitrateKbps: kbps })
    }
  }

  return c.json(getServerInfo())
})

serverInfoRoutes.post('/announce', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

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

  if (invite.expires_at !== null && invite.expires_at * 1000 < Date.now()) {
    return c.json({ error: 'Invite has expired' }, 400)
  }

  const authHeader = c.req.header('Authorization')
  let userId: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string }
      userId = payload.userId
    } catch {
      // Invalid token — user must register
    }
  }

  if (userId) {
    const existing = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(userId)
    if (existing) return c.json({ ok: true, alreadyMember: true })

    const result = db.prepare(
      'UPDATE invite_codes SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > unixepoch())'
    ).run(code)
    if (result.changes === 0) {
      return c.json({ error: 'Invite has expired or reached maximum uses' }, 400)
    }

    db.prepare('INSERT OR REPLACE INTO server_members (user_id, role) VALUES (?, ?)').run(userId, 'member')
    assignDefaultRoles(userId)
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
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)
  const body = await c.req.json() as { role: 'admin' | 'member' }
  const { role } = body
  if (!['admin', 'member'].includes(role)) return c.json({ error: 'Invalid role' }, 400)

  const db = getDb()
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(targetUserId)
  if (!member) return c.json({ error: 'Member not found' }, 404)

  if (role === 'member' && isUserHost(targetUserId)) {
    return c.json({ error: 'Cannot demote the server host' }, 403)
  }

  db.prepare('UPDATE server_members SET role = ? WHERE user_id = ?').run(role, targetUserId)

  if (role === 'admin') {
    db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(targetUserId, 'admin-role')
  } else {
    db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(targetUserId, 'admin-role')
  }

  const updatedMember = getMemberById(targetUserId)
  if (updatedMember) {
    try { const io: any = c.get('io' as never); if (io) io.emit('member:updated', updatedMember) } catch {}
  }

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
  if (isUserHost(targetUserId)) {
    return c.json({ error: 'Cannot kick the server host' }, 403)
  }
  if (targetInfo && targetInfo.role === 'admin' && !isUserAdmin(user.userId)) {
    return c.json({ error: 'Cannot kick an admin' }, 403)
  }

  db.prepare('DELETE FROM server_members WHERE user_id = ?').run(targetUserId)
  try { const io: any = c.get('io' as never); if (io) io.emit('member:removed', { userId: targetUserId }) } catch {}
  return c.json({ ok: true })
})

serverInfoRoutes.patch('/members/:userId/custom-role', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

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
  const updatedMember = getMemberById(targetUserId)
  if (updatedMember) {
    try { const io: any = c.get('io' as never); if (io) io.emit('member:updated', updatedMember) } catch {}
  }
  return c.json({ ok: true })
})

serverInfoRoutes.post('/members/:userId/roles', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)
  const body = await c.req.json() as { roleId: string }
  const { roleId } = body
  if (!roleId) return c.json({ error: 'roleId is required' }, 400)

  const db = getDb()
  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(targetUserId)
  if (!member) return c.json({ error: 'Member not found' }, 404)

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId)
  if (!role) return c.json({ error: 'Role not found' }, 404)

  db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(targetUserId, roleId)
  const updatedMember = getMemberById(targetUserId)
  if (updatedMember) {
    try { const io: any = c.get('io' as never); if (io) io.emit('member:updated', updatedMember) } catch {}
  }
  return c.json({ ok: true })
})

serverInfoRoutes.delete('/members/:userId/roles/:roleId', authMiddleware, (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const targetUserId = c.req.param('userId') || ''
  const roleId = c.req.param('roleId') || ''
  if (!targetUserId || !roleId) return c.json({ error: 'Invalid user ID or role ID' }, 400)

  const db = getDb()
  if (roleId === 'admin-role' && isUserHost(targetUserId)) {
    return c.json({ error: 'Cannot remove admin role from the server host' }, 403)
  }
  db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(targetUserId, roleId)
  const updatedMember = getMemberById(targetUserId)
  if (updatedMember) {
    try { const io: any = c.get('io' as never); if (io) io.emit('member:updated', updatedMember) } catch {}
  }
  return c.json({ ok: true })
})

serverInfoRoutes.post('/members/:userId/generate-reset', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const targetUserId = c.req.param('userId') || ''
  if (!targetUserId) return c.json({ error: 'Invalid user ID' }, 400)

  const db = getDb()
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(targetUserId) as { id: string; username: string } | undefined
  if (!target) return c.json({ error: 'User not found' }, 404)

  const token = randomBytes(32).toString('hex')
  const expiresAt = Math.floor(Date.now() / 1000) + 86400

  db.prepare(
    'UPDATE users SET reset_token = ?, reset_token_expires_at = ?, reset_requested_at = NULL WHERE id = ?',
  ).run(token, expiresAt, targetUserId)

  return c.json({
    resetToken: token,
    username: target.username,
    expiresAt: expiresAt * 1000,
  })
})

// POST /background — upload background image (admin only)
serverInfoRoutes.post('/background', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_BACKGROUND_SIZE) {
    return c.json({ error: 'File too large. Maximum size is 10MB' }, 413)
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  const ext = path.extname(file.name).toLowerCase()
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    return c.json({ error: 'Only image files allowed (jpg, jpeg, png, webp)' }, 400)
  }

  if (file.size > MAX_BACKGROUND_SIZE) {
    return c.json({ error: 'File too large. Maximum size is 10MB' }, 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  const magicOk = ext === '.jpg' || ext === '.jpeg'
    ? buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF
    : ext === '.png'
    ? buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
    : ext === '.webp'
    ? buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    : false
  if (!magicOk) {
    return c.json({ error: 'File content does not match its extension' }, 415)
  }

  try {
    const oldFiles = fs.readdirSync(BACKGROUNDS_DIR)
    for (const f of oldFiles) fs.unlinkSync(path.join(BACKGROUNDS_DIR, f))
  } catch {}

  const storedFilename = `background${ext}`
  fs.writeFileSync(path.join(BACKGROUNDS_DIR, storedFilename), buffer)

  return c.json({ ok: true })
})

// GET /background — serve background image (public, no auth)
serverInfoRoutes.get('/background', (c) => {
  let bgFile: string | null = null
  try {
    const files = fs.readdirSync(BACKGROUNDS_DIR)
    if (files.length > 0) bgFile = files[0]
  } catch {}

  if (!bgFile) return c.json({ error: 'No background image' }, 404)

  const filepath = path.join(BACKGROUNDS_DIR, bgFile)
  const ext = path.extname(bgFile).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  const contentType = mimeMap[ext] || 'image/jpeg'

  return new Response(fs.createReadStream(filepath), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    },
  })
})

// DELETE /background — remove background image (admin only)
serverInfoRoutes.delete('/background', authMiddleware, (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  try {
    const files = fs.readdirSync(BACKGROUNDS_DIR)
    for (const f of files) fs.unlinkSync(path.join(BACKGROUNDS_DIR, f))
  } catch {}

  return c.json({ ok: true })
})

export default serverInfoRoutes
