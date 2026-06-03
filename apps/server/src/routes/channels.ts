import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, adminMiddleware, getUserPermissions, hasPermission, getUserInfo } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const channelRoutes = new Hono()

// GET /channels — list all channels
channelRoutes.get('/', authMiddleware, (c) => {
  const db = getDb()
  const channels = db.prepare('SELECT * FROM channels ORDER BY position ASC').all()
  return c.json({ channels })
})

// POST /channels — create channel (admin or manage_channels permission)
channelRoutes.post('/', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = await c.req.json() as { name: string; type: 'text' | 'voice' }
  const { name, type } = body
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!['text', 'voice'].includes(type)) return c.json({ error: 'Type must be text or voice' }, 400)

  const db = getDb()
  const id = uuidv4()
  const maxPos = db.prepare('SELECT MAX(position) as max FROM channels').get() as { max: number }
  const position = (maxPos?.max ?? -1) + 1
  db.prepare('INSERT INTO channels (id, name, type, position) VALUES (?, ?, ?, ?)').run(id, name.trim(), type, position)
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id)
  return c.json({ channel }, 201)
})

// DELETE /channels/:id — delete channel (admin or manage_channels permission)
channelRoutes.delete('/:id', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const id = c.req.param('id')
  const db = getDb()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id)
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id)
  db.prepare('DELETE FROM mentions WHERE channel_id = ?').run(id)
  db.prepare('DELETE FROM channel_reads WHERE channel_id = ?').run(id)
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  return c.json({ ok: true })
})

export default channelRoutes
