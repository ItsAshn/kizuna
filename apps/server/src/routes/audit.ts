import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { Hono } from 'hono'
import { authMiddleware, adminMiddleware } from '../middleware/auth'
import { getDb } from '../db'

export function logAuditEvent(
  db: Database.Database,
  action: string,
  actorId: string,
  targetId?: string | null,
  details?: string | null,
): void {
  const id = uuidv4()
  db.prepare(
    'INSERT INTO audit_logs (id, action, actor_id, target_id, details) VALUES (?, ?, ?, ?, ?)'
  ).run(id, action, actorId, targetId || null, details || null)
}

const auditRoutes = new Hono()

auditRoutes.get('/', authMiddleware, adminMiddleware, (c) => {
  const db = getDb()
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const before = c.req.query('before')
  const action = c.req.query('action')

  let query = `
    SELECT a.*, u.username as actor_username, u.display_name as actor_display_name
    FROM audit_logs a
    LEFT JOIN users u ON a.actor_id = u.id
  `
  const conditions: string[] = []
  const params: any[] = []

  if (action) {
    conditions.push('a.action = ?')
    params.push(action)
  }
  if (before) {
    conditions.push('a.created_at < (SELECT created_at FROM audit_logs WHERE id = ?)')
    params.push(before)
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ')
  }

  query += ' ORDER BY a.created_at DESC LIMIT ?'
  params.push(limit)

  const rows = db.prepare(query).all(...params) as any[]

  const logs = rows.map(r => ({
    id: r.id,
    action: r.action,
    actorId: r.actor_id,
    actorUsername: r.actor_username || 'Unknown',
    actorDisplayName: r.actor_display_name || 'Unknown',
    targetId: r.target_id,
    details: r.details ? JSON.parse(r.details) : null,
    createdAt: r.created_at * 1000,
  }))

  const hasMore = rows.length === limit

  return c.json({ logs, hasMore })
})

export default auditRoutes
export { auditRoutes }
