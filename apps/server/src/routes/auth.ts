import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import { getDb } from '../db'
import { signToken, authMiddleware, isUserAdmin } from '../middleware/auth'
import { generateChallenge, verifyPoW } from '../middleware/pow'
import type { AuthUser } from '../middleware/auth'
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

authRoutes.post('/register', async (c) => {
  const { username, password, display_name, serverPassword, public_key, challenge, nonce } = await c.req.json()

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

  if (!/^[\w.\-]+$/.test(username)) {
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
    const hash = await bcrypt.hash(password, 12)
    const id = uuidv4()

    db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash, public_key) VALUES (?, ?, ?, ?, ?)',
    ).run(id, username.toLowerCase().trim(), display_name || username, hash, public_key?.trim() || null)

    const userCount = db
      .prepare('SELECT COUNT(*) as n FROM server_members')
      .get() as { n: number }
    const isFirstUser = userCount.n === 0

    db.prepare('INSERT INTO server_members (user_id, role) VALUES (?, ?)').run(id, isFirstUser ? 'admin' : 'member')

    if (isFirstUser) {
      db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(id, 'admin-role')
    }

    const user = db
      .prepare(
        'SELECT id, username, display_name, avatar, public_key, created_at FROM users WHERE id = ?',
      )
      .get(id) as { id: string; username: string; display_name: string; avatar: string | null; public_key: string | null; created_at: number }

    return c.json(
      {
        token: signToken({ userId: user.id, username: user.username }),
        user: { ...user, role: isFirstUser ? 'admin' : 'member' },
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

authRoutes.post('/login', async (c) => {
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

  let member = db
    .prepare('SELECT role FROM server_members WHERE user_id = ?')
    .get(user.id) as { role: string } | undefined

  if (!member) {
    const anyAdmin = db
      .prepare("SELECT 1 FROM member_roles mr JOIN roles r ON mr.role_id = r.id WHERE r.is_admin = 1")
      .get()
    const isFirstAdmin = !anyAdmin
    db.prepare('INSERT INTO server_members (user_id, role) VALUES (?, ?)').run(user.id, isFirstAdmin ? 'admin' : 'member')
    if (isFirstAdmin) {
      db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)').run(user.id, 'admin-role')
    }
    member = { role: isFirstAdmin ? 'admin' : 'member' }
  }

  return c.json({
    token: signToken({ userId: user.id, username: user.username }),
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar: user.avatar,
      public_key: user.public_key,
      role: member.role,
    },
  })
})

authRoutes.get('/me', authMiddleware, (c) => {
  const auth = getAuth(c)
  const db = getDb()

  const user = db
    .prepare(
      'SELECT id, username, display_name, avatar, public_key, created_at FROM users WHERE id = ?',
    )
    .get(auth.userId) as { id: string; username: string; display_name: string; avatar: string | null; public_key: string | null; created_at: number } | undefined

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json({ user: { ...user, role: isUserAdmin(auth.userId) ? 'admin' : 'member' } })
})

authRoutes.patch('/profile', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { display_name, avatar } = await c.req.json()

  if (!display_name && avatar === undefined) {
    return c.json({ error: 'Nothing to update' }, 400)
  }

  const db = getDb()
  const user = db
    .prepare('SELECT id, username, display_name, avatar FROM users WHERE id = ?')
    .get(auth.userId) as { id: string; username: string; display_name: string; avatar: string | null } | undefined

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const newName = display_name?.trim() || user.display_name
  const newAvatar = avatar === null ? null : avatar || user.avatar

  db.prepare('UPDATE users SET display_name = ?, avatar = ? WHERE id = ?').run(
    newName,
    newAvatar,
    auth.userId,
  )

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      display_name: newName,
      avatar: newAvatar,
      role: isUserAdmin(auth.userId) ? 'admin' : 'member',
    },
  })
})

authRoutes.get('/users', authMiddleware, (c) => {
  const db = getDb()
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar, u.public_key, u.last_seen_at, u.reset_requested_at
       FROM users u
       LEFT JOIN server_members sm ON sm.user_id = u.id
       ORDER BY u.username`,
    )
    .all() as any[]

  const memberRoles = db.prepare(`
    SELECT mr.user_id, r.id, r.name, r.color, r.permissions, r.is_admin
    FROM member_roles mr
    JOIN roles r ON mr.role_id = r.id
  `).all() as { user_id: string; id: string; name: string; color: string; permissions: string; is_admin: number }[]

  const rolesByUser: Record<string, { id: string; name: string; color: string; permissions: Record<string, boolean>; is_admin: boolean }[]> = {}
  for (const row of memberRoles) {
    if (!rolesByUser[row.user_id]) rolesByUser[row.user_id] = []
    rolesByUser[row.user_id].push({
      id: row.id,
      name: row.name,
      color: row.color,
      permissions: (() => { try { return JSON.parse(row.permissions || '{}') } catch { return {} } })(),
      is_admin: row.is_admin === 1,
    })
  }

  // Also include legacy custom_role_id roles
  const legacyRoles = db.prepare(`
    SELECT sm.user_id, r.id, r.name, r.color, r.permissions, r.is_admin
    FROM server_members sm
    JOIN roles r ON sm.custom_role_id = r.id
    WHERE sm.custom_role_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = sm.user_id AND mr.role_id = sm.custom_role_id)
  `).all() as { user_id: string; id: string; name: string; color: string; permissions: string; is_admin: number }[]

  for (const row of legacyRoles) {
    if (!rolesByUser[row.user_id]) rolesByUser[row.user_id] = []
    if (!rolesByUser[row.user_id].some(r => r.id === row.id)) {
      rolesByUser[row.user_id].push({
        id: row.id,
        name: row.name,
        color: row.color,
        permissions: (() => { try { return JSON.parse(row.permissions || '{}') } catch { return {} } })(),
        is_admin: row.is_admin === 1,
      })
    }
  }

  const formatted = users.map((u: any) => {
    const userRoles = rolesByUser[u.id] || []
    const isAdmin = userRoles.some(r => r.is_admin)
    return {
      ...u,
      last_seen_at: u.last_seen_at ? u.last_seen_at * 1000 : null,
      role: isAdmin ? 'admin' : 'member',
      custom_roles: userRoles,
      custom_role_id: userRoles.length > 0 ? userRoles[0].id : null,
      custom_role_name: userRoles.length > 0 ? userRoles[0].name : null,
      custom_role_color: userRoles.length > 0 ? userRoles[0].color : null,
    }
  })

  return c.json({ users: formatted })
})

authRoutes.put('/public-key', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { public_key } = await c.req.json() as { public_key: string }
  if (!public_key?.trim()) return c.json({ error: 'public_key is required' }, 400)

  const db = getDb()
  db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(public_key.trim(), auth.userId)
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

authRoutes.post('/request-reset', async (c) => {
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
  return c.json({ ok: true })
})

authRoutes.post('/reset-password/:token', async (c) => {
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

  const hash = await bcrypt.hash(password, 12)
  db.prepare(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires_at = NULL, reset_requested_at = NULL, token_invalidated_at = ? WHERE id = ?',
  ).run(hash, Math.floor(Date.now() / 1000), user.id)

  return c.json({ ok: true })
})

export default authRoutes
