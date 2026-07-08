import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { requirePermission, authMiddleware } from '../middleware/auth'

const roleRoutes = new Hono()

// GET /roles — list custom roles (admin or manage_roles)
roleRoutes.get('/', authMiddleware, requirePermission('manage_roles'), (c) => {
  const db = getDb()
  const roles = db.prepare('SELECT * FROM roles ORDER BY position ASC').all() as {
    id: string; name: string; color: string; permissions: string;
    is_admin: number; position: number; hoist: number; mentionable: number;
    default_on_join: number; created_at: number
  }[]
  const result = roles.map((r) => ({
    ...r,
    permissions: JSON.parse(r.permissions || '{}'),
    is_admin: r.is_admin === 1,
    hoist: r.hoist === 1,
    mentionable: r.mentionable === 1,
    default_on_join: r.default_on_join === 1,
    created_at: r.created_at ? r.created_at * 1000 : undefined,
  }))
  return c.json({ roles: result })
})

// POST /roles — create role
roleRoutes.post('/', authMiddleware, requirePermission('manage_roles'), async (c) => {
  const body = await c.req.json() as {
    name: string
    color: string
    permissions: Record<string, boolean>
    position?: number
    hoist?: boolean
    mentionable?: boolean
    default_on_join?: boolean
  }
  const { name, color, permissions, position, hoist, mentionable, default_on_join } = body
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)

  const db = getDb()
  const id = uuidv4()

  let pos = position ?? 0
  if (pos === 0) {
    const maxRow = db.prepare('SELECT MAX(position) as maxPos FROM roles').get() as { maxPos: number | null }
    pos = (maxRow?.maxPos ?? 0) + 1
  }

  db.prepare(
    'INSERT INTO roles (id, name, color, permissions, position, hoist, mentionable, default_on_join) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name.trim(), color || '#5865f2', JSON.stringify(permissions || {}), pos, hoist ? 1 : 0, mentionable ? 1 : 0, default_on_join ? 1 : 0)

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as {
    id: string; name: string; color: string; permissions: string;
    is_admin: number; position: number; hoist: number; mentionable: number;
    default_on_join: number; created_at: number
  }
  return c.json({
    role: {
      ...role,
      permissions: JSON.parse(role.permissions || '{}'),
      is_admin: role.is_admin === 1,
      hoist: role.hoist === 1,
      mentionable: role.mentionable === 1,
      default_on_join: role.default_on_join === 1,
      created_at: role.created_at ? role.created_at * 1000 : undefined,
    },
  }, 201)
})

// PATCH /roles/:id — update role
roleRoutes.patch('/:id', authMiddleware, requirePermission('manage_roles'), async (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id)
  if (!existing) return c.json({ error: 'Role not found' }, 404)

  const body = await c.req.json() as {
    name: string
    color: string
    permissions: Record<string, boolean>
    position?: number
    hoist?: boolean
    mentionable?: boolean
    default_on_join?: boolean
  }
  const { name, color, permissions, position, hoist, mentionable, default_on_join } = body

  const existingRow = existing as {
    name: string; color: string; permissions: string; position: number;
    hoist: number; mentionable: number; default_on_join: number
  }
  const updatedPermissions = permissions !== undefined
    ? JSON.stringify(permissions)
    : existingRow.permissions

  const hoistVal = hoist !== undefined ? (hoist ? 1 : 0) : existingRow.hoist
  const mentionableVal = mentionable !== undefined ? (mentionable ? 1 : 0) : existingRow.mentionable
  const defaultJoinVal = default_on_join !== undefined ? (default_on_join ? 1 : 0) : existingRow.default_on_join

  db.prepare('UPDATE roles SET name = ?, color = ?, permissions = ?, position = ?, hoist = ?, mentionable = ?, default_on_join = ? WHERE id = ?').run(
    name?.trim() || existingRow.name,
    color || existingRow.color,
    updatedPermissions,
    position ?? existingRow.position,
    hoistVal,
    mentionableVal,
    defaultJoinVal,
    id,
  )

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as {
    id: string; name: string; color: string; permissions: string;
    is_admin: number; position: number; hoist: number; mentionable: number;
    default_on_join: number; created_at: number
  }
  return c.json({
    role: {
      ...role,
      permissions: JSON.parse(role.permissions || '{}'),
      is_admin: role.is_admin === 1,
      hoist: role.hoist === 1,
      mentionable: role.mentionable === 1,
      default_on_join: role.default_on_join === 1,
      created_at: role.created_at ? role.created_at * 1000 : undefined,
    },
  })
})

// DELETE /roles/:id — delete role
roleRoutes.delete('/:id', authMiddleware, requirePermission('manage_roles'), (c) => {
  const id = c.req.param('id')
  const db = getDb()
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as { is_admin: number } | undefined
  if (!existing) return c.json({ error: 'Role not found' }, 404)
  if (existing.is_admin === 1) return c.json({ error: 'Cannot delete the admin role' }, 403)
  db.prepare('UPDATE server_members SET custom_role_id = NULL WHERE custom_role_id = ?').run(id)
  db.prepare('DELETE FROM member_roles WHERE role_id = ?').run(id)
  db.prepare('DELETE FROM roles WHERE id = ?').run(id)
  return c.json({ ok: true })
})

// PATCH /roles/reorder — reorder roles by position
roleRoutes.patch('/reorder', authMiddleware, requirePermission('manage_roles'), async (c) => {
  const body = await c.req.json() as { order: { id: string; position: number }[] }
  const { order } = body
  if (!Array.isArray(order)) return c.json({ error: 'Invalid order' }, 400)

  const db = getDb()
  const stmt = db.prepare('UPDATE roles SET position = ? WHERE id = ? AND is_admin = 0')
  const tx = db.transaction(() => {
    for (const item of order) {
      stmt.run(item.position, item.id)
    }
  })
  tx()
  return c.json({ ok: true })
})

// GET /roles/mentionable — return mentionable roles for autocomplete
roleRoutes.get('/mentionable', authMiddleware, (c) => {
  const db = getDb()
  const roles = db.prepare(
    'SELECT id, name, color FROM roles WHERE mentionable = 1 ORDER BY position ASC'
  ).all() as { id: string; name: string; color: string }[]
  return c.json({ roles })
})

export default roleRoutes
