import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, getUserChannelPermissions, canWriteToChannel } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const channelRoutes = new Hono()

function mapChannel(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    topic: row.topic ?? null,
    position: row.position,
    locked: row.locked === 1,
    write_role_id: row.write_role_id ?? null,
    write_role_name: row.write_role_name ?? null,
    created_at: row.created_at,
  }
}

// GET /channels — list all channels
channelRoutes.get('/', authMiddleware, (c) => {
  const db = getDb()
  const channels = db.prepare(`
    SELECT c.*, r.name as write_role_name
    FROM channels c
    LEFT JOIN roles r ON c.write_role_id = r.id
    ORDER BY c.position ASC
  `).all() as any[]
  return c.json({ channels: channels.map(mapChannel) })
})

// POST /channels — create channel (manage_channels permission)
channelRoutes.post('/', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = await c.req.json() as { name: string; type: 'text' | 'voice'; topic?: string; locked?: boolean; write_role_id?: string | null }
  const { name, type, topic, locked, write_role_id } = body
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)
  if (!['text', 'voice'].includes(type)) return c.json({ error: 'Type must be text or voice' }, 400)

  const db = getDb()
  const id = uuidv4()
  const maxPos = db.prepare('SELECT MAX(position) as max FROM channels').get() as { max: number }
  const position = (maxPos?.max ?? -1) + 1
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-')
  const isLocked = locked ? 1 : 0
  db.prepare('INSERT INTO channels (id, name, type, topic, position, locked, write_role_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, slug, type, topic || null, position, isLocked, write_role_id || null)

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as any

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:created', mapChannel(channel))
  } catch { /* best-effort */ }

  return c.json({ channel: mapChannel(channel) }, 201)
})

// PATCH /channels/:id — update channel name/topic/lock (manage_channels permission)
channelRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const db = getDb()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(c.req.param('id')) as any
  if (!channel) return c.json({ error: 'Channel not found' }, 404)

  const body = await c.req.json() as { name?: string; topic?: string | null; locked?: boolean; write_role_id?: string | null }
  const { name, topic, locked, write_role_id } = body

  const dbFields: string[] = []
  const dbValues: any[] = []

  if (name !== undefined) {
    dbFields.push('name = ?')
    dbValues.push(name.trim().toLowerCase().replace(/\s+/g, '-'))
  }
  if (topic !== undefined) {
    dbFields.push('topic = ?')
    dbValues.push(topic)
  }
  if (locked !== undefined) {
    dbFields.push('locked = ?')
    dbValues.push(locked ? 1 : 0)
  }
  if (write_role_id !== undefined) {
    dbFields.push('write_role_id = ?')
    dbValues.push(write_role_id)
  }

  if (dbFields.length > 0) {
    dbValues.push(c.req.param('id'))
    db.prepare(`UPDATE channels SET ${dbFields.join(', ')} WHERE id = ?`).run(...dbValues)
  }

  const updated = db.prepare('SELECT * FROM channels WHERE id = ?').get(c.req.param('id')) as any

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:updated', mapChannel(updated))
  } catch { /* best-effort */ }

  return c.json({ channel: mapChannel(updated) })
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

// GET /channels/:id/permissions — check user's write permission for a channel
channelRoutes.get('/:id/permissions', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('id')
  const perms = getUserChannelPermissions(user.userId, channelId)
  return c.json(perms)
})

export default channelRoutes
