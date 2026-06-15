import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware, adminMiddleware } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'

const categoryRoutes = new Hono()

categoryRoutes.get('/', authMiddleware, (c) => {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM channel_categories ORDER BY position ASC').all() as any[]
  const categories = rows.map(r => ({
    id: r.id,
    name: r.name,
    position: r.position,
  }))
  return c.json({ categories })
})

categoryRoutes.post('/', authMiddleware, adminMiddleware, (c) => {
  const db = getDb()
  let body: any
  try { body = c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }
  const name = body?.name?.trim()
  if (!name) return c.json({ error: 'Name required' }, 400)

  const id = uuidv4()
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as pos FROM channel_categories').get() as any
  db.prepare('INSERT INTO channel_categories (id, name, position) VALUES (?, ?, ?)').run(id, name, maxPos.pos + 1)

  return c.json({ id, name, position: maxPos.pos + 1 })
})

categoryRoutes.patch('/:id', authMiddleware, adminMiddleware, (c) => {
  const categoryId = c.req.param('id')
  const db = getDb()
  let body: any
  try { body = c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

  if (body.name) {
    db.prepare('UPDATE channel_categories SET name = ? WHERE id = ?').run(body.name.trim(), categoryId)
  }
  const row = db.prepare('SELECT * FROM channel_categories WHERE id = ?').get(categoryId) as any
  return c.json({ id: row.id, name: row.name, position: row.position })
})

categoryRoutes.delete('/:id', authMiddleware, adminMiddleware, (c) => {
  const categoryId = c.req.param('id')
  const db = getDb()
  db.prepare('UPDATE channels SET category_id = NULL WHERE category_id = ?').run(categoryId)
  db.prepare('DELETE FROM channel_categories WHERE id = ?').run(categoryId)
  return c.json({ success: true })
})

export default categoryRoutes
export { categoryRoutes }
