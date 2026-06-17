import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { getDb } from '../db'
import { signToken, authMiddleware, isUserAdmin, isUserHost, getUserInfo, getUserPermissions, getJwtSecret, assignDefaultRoles } from '../middleware/auth'
import type { AuthUser, JwtPayload } from '../middleware/auth'
import { generateChallenge, verifyPoW } from '../middleware/pow'
import { sensitiveAuthLimiter } from '../middleware/rateLimiter'
import { getMemberById } from '../routes/serverInfo'
import jwt from 'jsonwebtoken'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const authRoutes = new Hono()

authRoutes.get('/challenge', (c) => {
  const entry = generateChallenge()
  return c.json({
    challenge: entry.challenge,
    difficulty: entry.difficulty,
    expiresAt: entry.expiresAt,
  })
})

authRoutes.post('/register', sensitiveAuthLimiter, async (c) => {
  const { username, password, display_name, serverPassword, public_key, key_salt, challenge, nonce } = await c.req.json()

  if (!username || !password) {
    return c.json({ error: 'username and password required' }, 400)
  }

  if (!challenge || !nonce) {
    return c.json({ error: 'Proof of work required' }, 400)
  }

  if (!verifyPoW(challenge, nonce)) {
    return c.json({ error: 'Invalid or expired proof of work. Please solve a new challenge.' }, 400)
  }

  if (username.length < 2 || username.length > 32) {
    return c.json({ error: 'Username must be 2-32 characters' }, 400)
  }

  if (!/^[\w.-]+$/.test(username)) {
    return c.json({
      error: 'Username may only contain letters, numbers, underscores, hyphens, and dots',
    }, 400)
  }

  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const required = process.env.SERVER_PASSWORD && process.env.SERVER_PASSWORD.trim()
  if (required && serverPassword !== required) {
    return c.json({ error: 'Incorrect server password' }, 403)
  }

  const db = getDb()
  try {
    const backuptoken = randomBytes(32).toString('hex')
    const [hash, backuptokenHash] = await Promise.all([
      bcrypt.hash(password, 12),
      bcrypt.hash(backuptoken, 12),
    ])
    const id = uuidv4()

    db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, public_key, key_salt, backuptoken_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, username.toLowerCase().trim(), display_name || username, hash, public_key?.trim() || null, key_salt?.trim() || null, backuptokenHash)

    const isFirstUser = db.transaction(() => {
      const userCount = db
        .prepare('SELECT COUNT(*) as n FROM server_members')
        .get() as { n: number }
      const first = userCount.n === 0
      db.prepare('INSERT INTO server_members (user_id, role, is_host) VALUES (?, ?, ?)').run(id, first ? 'admin' : 'member', first ? 1 : 0)
      return first
    })()

    if (isFirstUser) {
      db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(id, 'admin-role')
    } else {
      assignDefaultRoles(id)
    }

    const user = db
      .prepare(
        'SELECT id, username, display_name, avatar, public_key, key_salt, created_at FROM users WHERE id = ?',
      )
      .get(id) as { id: string; username: string; display_name: string; avatar: string | null; public_key: string | null; key_salt: string | null; created_at: number }

  const tokenId = uuidv4()
  const token = signToken({ userId: user.id, username: user.username, tokenId })
  db.prepare('INSERT OR REPLACE INTO sessions (token_id, user_id, created_at) VALUES (?, ?, unixepoch())').run(tokenId, user.id)
  c.header(
    'Set-Cookie',
    `kizuna_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  )
  try { const io: any = c.get('io' as never); if (io) io.emit('member:added', getMemberById(id)) } catch {}

  return c.json(
      {
        token,
        user: { ...user, role: isFirstUser ? 'admin' : 'member', is_host: isFirstUser },
        backuptoken,
      },
      201,
    )
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) {
      return c.json({ error: 'Username already taken on this server' }, 409)
    }
    console.error(err)
    return c.json({ error: 'Server error' }, 500)
  }
})

authRoutes.post('/login', sensitiveAuthLimiter, async (c) => {
  const { username, password } = await c.req.json()

  if (!username || !password) {
    return c.json({ error: 'username and password required' }, 400)
  }

  const db = getDb()
  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username.toLowerCase().trim()) as any

  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const ban = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(user.id) as any
  if (ban) {
    return c.json({ error: 'You are banned from this server' }, 403)
  }

  let member = db
    .prepare('SELECT role, is_host FROM server_members WHERE user_id = ?')
    .get(user.id) as { role: string; is_host: number } | undefined

  if (!member) {
    db.transaction(() => {
      const anyAdmin = db
        .prepare("SELECT 1 FROM member_roles mr JOIN roles r ON mr.role_id = r.id WHERE r.is_admin = 1")
        .get()
      const isFirstAdmin = !anyAdmin
      db.prepare('INSERT OR IGNORE INTO server_members (user_id, role, is_host) VALUES (?, ?, 0)').run(user.id, isFirstAdmin ? 'admin' : 'member')
      if (isFirstAdmin) {
        db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(user.id, 'admin-role')
      } else {
        assignDefaultRoles(user.id)
      }
    })()
    member = db.prepare('SELECT role, is_host FROM server_members WHERE user_id = ?').get(user.id) as { role: string; is_host: number } | undefined
    if (!member) {
      member = { role: 'member', is_host: 0 }
    }
    try { const io: any = c.get('io' as never); if (io) io.emit('member:added', getMemberById(user.id)) } catch {}
  }

  const tokenId = uuidv4()
  const token = signToken({ userId: user.id, username: user.username, tokenId })
  db.prepare('INSERT OR REPLACE INTO sessions (token_id, user_id, created_at) VALUES (?, ?, unixepoch())').run(tokenId, user.id)
  c.header(
    'Set-Cookie',
    `kizuna_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
  )
  return c.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar: user.avatar,
      banner: user.banner,
      public_key: user.public_key,
      key_salt: user.key_salt,
      role: member.role,
      is_host: member.is_host === 1,
    },
  })
})

authRoutes.get('/me', authMiddleware, (c) => {
  const auth = getAuth(c)
  const db = getDb()

  const user = db
    .prepare(
      'SELECT u.id, u.username, u.display_name, u.avatar, u.banner, u.public_key, u.key_salt, u.created_at, sm.is_host FROM users u LEFT JOIN server_members sm ON sm.user_id = u.id WHERE u.id = ?',
    )
    .get(auth.userId) as { id: string; username: string; display_name: string; avatar: string | null; banner: string | null; public_key: string | null; key_salt: string | null; created_at: number; is_host: number | null } | undefined

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const { is_host, ...userFields } = user
  const perms = getUserPermissions(auth.userId)
  return c.json({
    user: { ...userFields, role: isUserAdmin(auth.userId) ? 'admin' : 'member', is_host: is_host === 1, permissions: perms?.permissions } })
})

authRoutes.patch('/profile', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { display_name, avatar, banner } = await c.req.json()

  if (!display_name && avatar === undefined && banner === undefined) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const db = getDb()
  const user = db
    .prepare('SELECT id, username, display_name, avatar, banner FROM users WHERE id = ?')
    .get(auth.userId) as { id: string; username: string; display_name: string; avatar: string | null; banner: string | null } | undefined

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const newName = display_name?.trim() || user.display_name
  const newAvatar = avatar === null ? null : avatar || user.avatar
  const newBanner = banner === null ? null : banner || user.banner

  db.prepare('UPDATE users SET display_name = ?, avatar = ?, banner = ? WHERE id = ?').run(
    newName,
    newAvatar,
    newBanner,
    auth.userId,
  )

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      display_name: newName,
      avatar: newAvatar,
      banner: newBanner,
      role: isUserAdmin(auth.userId) ? 'admin' : 'member',
      is_host: isUserHost(auth.userId),
    },
  })
})

authRoutes.get('/users', authMiddleware, (c) => {
  const db = getDb()
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0)
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50))

  const total = (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n

  const users = db
    .prepare(
       `SELECT u.id, u.username, u.display_name, u.avatar, u.banner, u.public_key, u.last_seen_at, u.reset_requested_at, sm.is_host
       FROM users u
       LEFT JOIN server_members sm ON sm.user_id = u.id
       ORDER BY u.username
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as any[]

  if (users.length === 0) {
    return c.json({ users: [], total, offset, limit })
  }

  const userIds = users.map((u: any) => u.id)
  const placeholders = userIds.map(() => '?').join(',')

  const memberRoles = db.prepare(`
    SELECT mr.user_id, r.id, r.name, r.color, r.permissions, r.is_admin, r.position, r.hoist
    FROM member_roles mr
    JOIN roles r ON mr.role_id = r.id
    WHERE mr.user_id IN (${placeholders})
    ORDER BY r.position ASC
  `).all(...userIds) as { user_id: string; id: string; name: string; color: string; permissions: string; is_admin: number; position: number; hoist: number }[]

  const rolesByUser: Record<string, { id: string; name: string; color: string; permissions: Record<string, boolean>; is_admin: boolean; position: number; hoist: boolean }[]> = {}
  for (const row of memberRoles) {
    if (!rolesByUser[row.user_id]) rolesByUser[row.user_id] = []
    rolesByUser[row.user_id]!.push({
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
    SELECT sm.user_id, r.id, r.name, r.color, r.permissions, r.is_admin, r.position, r.hoist
    FROM server_members sm
    JOIN roles r ON sm.custom_role_id = r.id
    WHERE sm.custom_role_id IS NOT NULL AND sm.user_id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = sm.user_id AND mr.role_id = sm.custom_role_id)
  `).all(...userIds) as { user_id: string; id: string; name: string; color: string; permissions: string; is_admin: number; position: number; hoist: number }[]

  for (const row of legacyRoles) {
    if (!rolesByUser[row.user_id]) rolesByUser[row.user_id] = []
    if (!rolesByUser[row.user_id]!.some(r => r.id === row.id)) {
    rolesByUser[row.user_id]!.push({
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

  const formatted = users.map((u: any) => {
    const userRoles = rolesByUser[u.id] || []
    const isAdmin = userRoles.some(r => r.is_admin)
    const highestRole = userRoles.length > 0 ? userRoles[userRoles.length - 1] : null
    const hoistedRole = [...userRoles].reverse().find(r => r.hoist) || null
    return {
      ...u,
      last_seen_at: u.last_seen_at ? u.last_seen_at * 1000 : null,
      role: isAdmin ? 'admin' : 'member',
      is_host: u.is_host === 1,
      custom_roles: userRoles,
      custom_role_id: highestRole?.id ?? null,
      custom_role_name: highestRole?.name ?? null,
      custom_role_color: highestRole?.color ?? null,
      hoist_role_id: hoistedRole?.id ?? null,
      hoist_role_name: hoistedRole?.name ?? null,
      hoist_role_color: hoistedRole?.color ?? null,
    }
  })

  return c.json({ users: formatted, total, offset, limit })
})

authRoutes.put('/public-key', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { public_key, key_salt } = await c.req.json() as { public_key: string; key_salt?: string }
  if (!public_key?.trim()) return c.json({ error: 'public_key is required' }, 400)

  const db = getDb()
  db.prepare('UPDATE users SET public_key = ?, key_salt = COALESCE(?, key_salt) WHERE id = ?').run(public_key.trim(), key_salt?.trim() || null, auth.userId)
  return c.json({ ok: true })
})

authRoutes.get('/users/:userId/public-key', authMiddleware, (c) => {
  const userId = c.req.param('userId')
  if (!userId) return c.json({ error: 'User ID is required' }, 400)

  const db = getDb()
  const user = db.prepare('SELECT public_key FROM users WHERE id = ?').get(userId) as { public_key: string | null } | undefined
  if (!user) return c.json({ error: 'User not found' }, 404)

  return c.json({ public_key: user.public_key || null })
})

authRoutes.post('/request-reset', sensitiveAuthLimiter, async (c) => {
  const { username } = await c.req.json()
  if (!username || !username.trim()) {
    return c.json({ error: 'Username is required' }, 400)
  }

  const db = getDb()
  const user = db.prepare('SELECT id FROM users WHERE username = ?')
    .get(username.toLowerCase().trim()) as { id: string } | undefined

  if (!user) {
    return c.json({ ok: true })
  }

  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE users SET reset_requested_at = ? WHERE id = ?').run(now, user.id)

  return c.json({ ok: true })
})

authRoutes.post('/reset-with-backuptoken', sensitiveAuthLimiter, async (c) => {
  const { username, backuptoken, new_password } = await c.req.json() as { username?: string; backuptoken?: string; new_password?: string }
  if (!username || !backuptoken || !new_password) {
    return c.json({ error: 'username, backuptoken, and new_password are required' }, 400)
  }
  if (new_password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const db = getDb()
  const user = db.prepare(
    'SELECT id, backuptoken_hash FROM users WHERE username = ?',
  ).get(username.toLowerCase().trim()) as { id: string; backuptoken_hash: string | null } | undefined

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  if (!user.backuptoken_hash) {
    return c.json({ error: 'No backup token set for this account. Contact an admin for password recovery.' }, 400)
  }

  const valid = await bcrypt.compare(backuptoken, user.backuptoken_hash)
  if (!valid) {
    return c.json({ error: 'Invalid backup token' }, 400)
  }

  const newBackuptoken = randomBytes(32).toString('hex')
  const [hash, backuptokenHash] = await Promise.all([
    bcrypt.hash(new_password, 12),
    bcrypt.hash(newBackuptoken, 12),
  ])

  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE users SET password_hash = ?, backuptoken_hash = ?, reset_requested_at = NULL, token_invalidated_at = ? WHERE id = ?',
  ).run(hash, backuptokenHash, now, user.id)

  return c.json({ ok: true, backuptoken: newBackuptoken })
})

authRoutes.post('/refresh', async (c) => {
  let token: string | undefined
  const cookieHeader = c.req.header('Cookie')
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)kizuna_token=([^;]*)/)
    if (match) token = match[1]
  }
  if (!token) {
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) token = authHeader.slice(7)
  }
  if (!token) {
    return c.json({ error: 'No token provided' }, 401)
  }

  try {
    const payload = jwt.verify(token, getJwtSecret(), { ignoreExpiration: true }) as JwtPayload
    const userInfo = getUserInfo(payload.userId)
    if (!userInfo) {
      return c.json({ error: 'User not found' }, 401)
    }

    const db = getDb()
    const row = db.prepare('SELECT token_invalidated_at FROM users WHERE id = ?').get(payload.userId) as { token_invalidated_at: number | null } | undefined
    if (row?.token_invalidated_at && payload.iat && row.token_invalidated_at > payload.iat) {
      return c.json({ error: 'Token has been revoked' }, 401)
    }

    const tokenId = uuidv4()
    const newToken = signToken({ userId: userInfo.userId, username: userInfo.username, tokenId })
    db.prepare('INSERT OR REPLACE INTO sessions (token_id, user_id, created_at) VALUES (?, ?, unixepoch())').run(tokenId, userInfo.userId)
    c.header(
      'Set-Cookie',
      `kizuna_token=${newToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    )
    return c.json({ ok: true, token: newToken })
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
})

authRoutes.get('/reset-password/:token', (c) => {
  const token = c.req.param('token') || ''
  if (!token) return c.json({ error: 'Invalid token' }, 400)

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const user = db.prepare(
    'SELECT username, reset_token_expires_at FROM users WHERE reset_token = ?',
  ).get(token) as { username: string; reset_token_expires_at: number } | undefined

  if (!user || user.reset_token_expires_at < now) {
    return c.json({ error: 'Invalid or expired reset token' }, 400)
  }

  return c.json({ username: user.username })
})

authRoutes.post('/logout', authMiddleware, (c) => {
  const auth = getAuth(c)
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE users SET token_invalidated_at = ? WHERE id = ?').run(now, auth.userId)

  const cookieHeader = c.req.header('Cookie')
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)kizuna_token=([^;]*)/)
    if (match) {
      try {
        const payload = jwt.decode(match[1]!) as { tokenId?: string } | null
        if (payload?.tokenId) {
          db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_id = ?').run(now, payload.tokenId)
        }
      } catch { /* ignore decode errors */ }
    }
  }

  c.header('Set-Cookie', 'kizuna_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  return c.json({ ok: true })
})

authRoutes.post('/reset-password/:token', sensitiveAuthLimiter, async (c) => {
  const token = c.req.param('token') || ''
  if (!token) return c.json({ error: 'Invalid token' }, 400)

  const { password } = await c.req.json() as { password?: string }
  if (!password || password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const user = db.prepare(
    'SELECT id, reset_token_expires_at FROM users WHERE reset_token = ?',
  ).get(token) as { id: string; reset_token_expires_at: number } | undefined

  if (!user || user.reset_token_expires_at < now) {
    return c.json({ error: 'Invalid or expired reset token' }, 400)
  }

  const newBackuptoken = randomBytes(32).toString('hex')
  const [hash, backuptokenHash] = await Promise.all([
    bcrypt.hash(password, 12),
    bcrypt.hash(newBackuptoken, 12),
  ])

  db.prepare(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires_at = NULL, reset_requested_at = NULL, backuptoken_hash = ?, token_invalidated_at = ? WHERE id = ?',
  ).run(hash, backuptokenHash, now, user.id)

  return c.json({ ok: true, backuptoken: newBackuptoken })
})

export default authRoutes
