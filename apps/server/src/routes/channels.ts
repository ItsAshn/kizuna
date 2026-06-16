import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, getUserChannelPermissions, getUserChannelPermission, canWriteToChannel } from '../middleware/auth'
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

// GET /channels/:id/permissions — check user's resolved permissions for a channel
channelRoutes.get('/:id/permissions', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('id')!
  const perms = getUserChannelPermissions(user.userId, channelId)
  const resolved: Record<string, boolean> = {}
  const allPermissions = [
    'send_messages', 'send_dm_messages', 'add_reactions', 'upload_attachments',
    'delete_messages', 'manage_channels', 'manage_roles', 'kick_members',
    'manage_invites', 'use_voice', 'initiate_dm_calls',
  ]
  for (const p of allPermissions) {
    resolved[p] = getUserChannelPermission(user.userId, channelId, p)
  }
  return c.json({ ...perms, permissions: resolved })
})

// GET /channels/:id/overrides — list all role overrides for a channel
channelRoutes.get('/:id/overrides', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const channelId = c.req.param('id')
  const db = getDb()
  const overrides = db.prepare(`
    SELECT cro.*, r.name as role_name, r.color as role_color, r.position as role_position
    FROM channel_role_overrides cro
    JOIN roles r ON cro.role_id = r.id
    WHERE cro.channel_id = ?
    ORDER BY r.position ASC
  `).all(channelId) as any[]

  const result = overrides.map((o: any) => ({
    channel_id: o.channel_id,
    role_id: o.role_id,
    role_name: o.role_name,
    role_color: o.role_color,
    role_position: o.role_position,
    allow_permissions: (() => { try { return JSON.parse(o.allow_permissions || '{}') } catch { return {} } })(),
    deny_permissions: (() => { try { return JSON.parse(o.deny_permissions || '{}') } catch { return {} } })(),
  }))
  return c.json({ overrides: result })
})

// PUT /channels/:id/overrides/:roleId — set or update a channel role override
channelRoutes.put('/:id/overrides/:roleId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const channelId = c.req.param('id')
  const roleId = c.req.param('roleId')
  const body = await c.req.json() as {
    allow_permissions?: Record<string, boolean>
    deny_permissions?: Record<string, boolean>
  }
  const db = getDb()
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId)
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  const role = db.prepare('SELECT id FROM roles WHERE id = ?').get(roleId)
  if (!role) return c.json({ error: 'Role not found' }, 404)

  db.prepare(
    `INSERT OR REPLACE INTO channel_role_overrides (channel_id, role_id, allow_permissions, deny_permissions)
     VALUES (?, ?, ?, ?)`
  ).run(
    channelId,
    roleId,
    JSON.stringify(body.allow_permissions || {}),
    JSON.stringify(body.deny_permissions || {}),
  )

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:updated', { id: channelId })
  } catch {}

  return c.json({ ok: true })
})

// DELETE /channels/:id/overrides/:roleId — remove a channel role override
channelRoutes.delete('/:id/overrides/:roleId', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const channelId = c.req.param('id')
  const roleId = c.req.param('roleId')
  const db = getDb()
  db.prepare(
    'DELETE FROM channel_role_overrides WHERE channel_id = ? AND role_id = ?'
  ).run(channelId, roleId)

  try {
    const io: any = c.get('io' as never)
    if (io) io.emit('channel:updated', { id: channelId })
  } catch {}

  return c.json({ ok: true })
})

export default channelRoutes
