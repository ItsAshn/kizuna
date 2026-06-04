import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const channelRoutes = new Hono()

// GET /channels — list all channels
channelRoutes.get('/', authMiddleware, (c) => {
  const db = getDb()
  const channels = db.prepare('SELECT * FROM channels ORDER BY position ASC').all()
  return c.json({ channels })
})

// POST /channels — create channel (manage_channels permission)
channelRoutes.post('/', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = await c.req.json() as { name: string; type: 'text' | 'voice'; topic?: string }
  const { name, type, topic } = body
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!['text', 'voice'].includes(type)) return c.json({ error: 'Type must be text or voice' }, 400)

  const db = getDb()
  const id = uuidv4()
  const maxPos = db.prepare('SELECT MAX(position) as max FROM channels').get() as { max: number }
  const position = (maxPos?.max ?? -1) + 1
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
  db.prepare('INSERT INTO channels (id, name, type, topic, position) VALUES (?, ?, ?, ?, ?)').run(id, slug, type, topic || null, position)
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id)

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:created', channel)
  } catch { /* best-effort */ }

  return c.json({ channel }, 201)
})

// PATCH /channels/:id — update channel name/topic (manage_channels permission)
channelRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const db = getDb()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(c.req.param('id')) as any
  if (!channel) return c.json({ error: 'Channel not found' }, 404)

  const body = await c.req.json() as { name?: string; topic?: string | null }
  const { name, topic } = body

  db.prepare('UPDATE channels SET name = ?, topic = ? WHERE id = ?').run(
    name !== undefined ? name.trim().toLowerCase().replace(/\s+/g, '-') : channel.name,
    topic !== undefined ? topic : channel.topic,
    c.req.param('id'),
  )

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(c.req.param('id'))

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:updated', updated)
  } catch { /* best-effort */ }

  return c.json({ channel: updated })
})

// DELETE /channels/:id — delete channel (manage_channels permission)
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

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:deleted', { id })
  } catch { /* best-effort */ }

  return c.json({ ok: true })
})

export default channelRoutes
