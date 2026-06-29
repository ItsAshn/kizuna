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
  const params: unknown[] = []

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

  const rows = db.prepare(query).all(...params) as { id: string; action: string; actor_id: string; actor_username: string | null; actor_display_name: string | null; target_id: string | null; details: string | null; created_at: number }[]

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

auditRoutes.delete('/', authMiddleware, adminMiddleware, (c) => {
  const db = getDb()
  const user = c.get('auth' as never) as { userId: string }

  logAuditEvent(db, 'audit_logs_cleared', user.userId)

  db.prepare('DELETE FROM audit_logs').run()

  return c.json({ ok: true })
})

const AUDIT_LOG_RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '30', 10)

export function startAuditLogCleanup(): void {
  if (AUDIT_LOG_RETENTION_DAYS <= 0) return

  const run = () => {
    try {
      const db = getDb()
      const cutoff = Math.floor(Date.now() / 1000) - AUDIT_LOG_RETENTION_DAYS * 86400
      const deleted = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff)
      if (deleted.changes > 0) {
        console.log(`[audit] Cleaned up ${deleted.changes} log entries older than ${AUDIT_LOG_RETENTION_DAYS} days`)
      }
    } catch (err: unknown) {
      console.error('[audit] Cleanup error:', err instanceof Error ? err.message : err)
    }
  }

  run()
  setInterval(run, 3600_000).unref()
}

export default auditRoutes
export { auditRoutes }
