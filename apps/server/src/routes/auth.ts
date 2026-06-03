import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'
import { getDb } from '../db'
import { signToken, authMiddleware } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const authRoutes = new Hono()

authRoutes.post('/register', async (c) => {
  const { username, password, display_name, serverPassword } = await c.req.json()

  if (!username || !password) {
    return c.json({ error: 'username and password required' }, 400)
  }

  if (username.length < 2 || username.length > 32) {
    return c.json({ error: 'Username must be 2-32 characters' }, 400)
  }

  if (!/^[\w.\-]+$/.test(username)) {
    return c.json({
      error: 'Username may only contain letters, numbers, underscores, hyphens, and dots',
    }, 400)
  }

  if (password.length < 6) {
    return c.json({ error: 'Password must be at least 6 characters' }, 400)
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
      'INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
    ).run(id, username.toLowerCase().trim(), display_name || username, hash)

    const userCount = db
      .prepare('SELECT COUNT(*) as n FROM server_members')
      .get() as { n: number }
    const role = userCount.n === 0 ? 'admin' : 'member'

    db.prepare('INSERT INTO server_members (user_id, role) VALUES (?, ?)').run(id, role)

    const user = db
      .prepare(
        'SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?',
      )
      .get(id) as { id: string; username: string; display_name: string; avatar: string | null; created_at: number }

    return c.json(
      {
        token: signToken({ userId: user.id, username: user.username }),
        user: { ...user, role },
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
      .prepare("SELECT 1 FROM server_members WHERE role = 'admin'")
      .get()
    const role = anyAdmin ? 'member' : 'admin'
    db.prepare('INSERT INTO server_members (user_id, role) VALUES (?, ?)').run(user.id, role)
    member = { role }
  }

  return c.json({
    token: signToken({ userId: user.id, username: user.username }),
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar: user.avatar,
      role: member.role,
    },
  })
})

authRoutes.get('/me', authMiddleware, (c) => {
  const auth = getAuth(c)
  const db = getDb()

  const user = db
    .prepare(
      'SELECT id, username, display_name, avatar, created_at FROM users WHERE id = ?',
    )
    .get(auth.userId) as { id: string; username: string; display_name: string; avatar: string | null; created_at: number } | undefined

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const member = db
    .prepare('SELECT role FROM server_members WHERE user_id = ?')
    .get(auth.userId) as { role: string } | undefined

  return c.json({ user: { ...user, role: member?.role || 'member' } })
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

  const member = db
    .prepare('SELECT role FROM server_members WHERE user_id = ?')
    .get(auth.userId) as { role: string }

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      display_name: newName,
      avatar: newAvatar,
      role: member?.role || 'member',
    },
  })
})

authRoutes.get('/users', authMiddleware, (c) => {
  const db = getDb()
  const users = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar, u.last_seen_at,
              COALESCE(sm.role, 'member') as role,
              sm.custom_role_id,
              r.name  AS custom_role_name,
              r.color AS custom_role_color
       FROM users u
       LEFT JOIN server_members sm ON sm.user_id = u.id
       LEFT JOIN roles r ON r.id = sm.custom_role_id
       ORDER BY u.username`,
    )
    .all()

  const formatted = users.map((u: any) => ({
    ...u,
    last_seen_at: u.last_seen_at ? u.last_seen_at * 1000 : null,
  }))

  return c.json({ users: formatted })
})

export default authRoutes
