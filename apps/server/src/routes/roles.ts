import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, getUserPermissions, hasPermission, isUserAdmin } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const roleRoutes = new Hono()

// GET /roles — list custom roles (admin or manage_channels)
roleRoutes.get('/', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const db = getDb()
  const roles = db.prepare('SELECT * FROM roles').all() as any[]
  const result = roles.map((r) => ({
    ...r,
    permissions: JSON.parse(r.permissions || '{}'),
    is_admin: r.is_admin === 1,
    created_at: r.created_at ? r.created_at * 1000 : undefined,
  }))
  return c.json({ roles: result })
})

// POST /roles — create role
roleRoutes.post('/', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const body = await c.req.json() as {
    name: string
    color: string
    permissions: Record<string, boolean>
  }
  const { name, color, permissions } = body
  if (!name?.trim()) return c.json({ error: 'Name is required' }, 400)

  const db = getDb()
  const id = uuidv4()
  db.prepare(
    'INSERT INTO roles (id, name, color, permissions) VALUES (?, ?, ?, ?)'
  ).run(id, name.trim(), color || '#5865f2', JSON.stringify(permissions || {}))

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any
  return c.json({
    role: {
      ...role,
      permissions: JSON.parse(role.permissions || '{}'),
      created_at: role.created_at ? role.created_at * 1000 : undefined,
    },
  }, 201)
})

// PATCH /roles/:id — update role
roleRoutes.patch('/:id', authMiddleware, async (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const id = c.req.param('id')
  const db = getDb()
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id)
  if (!existing) return c.json({ error: 'Role not found' }, 404)

  const body = await c.req.json() as {
    name: string
    color: string
    permissions: Record<string, boolean>
  }
  const { name, color, permissions } = body

  const existingRow = existing as any
  const updatedPermissions = permissions !== undefined
    ? JSON.stringify(permissions)
    : existingRow.permissions

  db.prepare('UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?').run(
    name?.trim() || existingRow.name,
    color || existingRow.color,
    updatedPermissions,
    id,
  )

  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any
  return c.json({
    role: {
      ...role,
      permissions: JSON.parse(role.permissions || '{}'),
      created_at: role.created_at ? role.created_at * 1000 : undefined,
    },
  })
})

// DELETE /roles/:id — delete role
roleRoutes.delete('/:id', authMiddleware, (c) => {
  const user = getAuth(c)
  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'manage_channels')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const id = c.req.param('id')
  const db = getDb()
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any
  if (!existing) return c.json({ error: 'Role not found' }, 404)
  if (existing.is_admin === 1) return c.json({ error: 'Cannot delete the admin role' }, 403)
  db.prepare('UPDATE server_members SET custom_role_id = NULL WHERE custom_role_id = ?').run(id)
  db.prepare('DELETE FROM member_roles WHERE role_id = ?').run(id)
  db.prepare('DELETE FROM roles WHERE id = ?').run(id)
  return c.json({ ok: true })
})

export default roleRoutes
