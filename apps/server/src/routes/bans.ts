import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware, adminMiddleware, hasPermissionForUser, getUserInfo, isUserAdmin } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import { logAuditEvent } from '../routes/audit'

function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const banRoutes = new Hono()

banRoutes.get('/', authMiddleware, adminMiddleware, (c) => {
  const db = getDb()
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const rows = db.prepare(`
    SELECT b.*, u.username as banned_username, u.display_name as banned_display_name,
           ub.username as banner_username
    FROM bans b
    LEFT JOIN users u ON b.user_id = u.id
    LEFT JOIN users ub ON b.banned_by = ub.id
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(limit) as any[]

  const bans = rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    bannedBy: r.banned_by,
    reason: r.reason,
    bannedUsername: r.banned_username || 'Unknown',
    bannedDisplayName: r.banned_display_name || 'Unknown',
    bannerUsername: r.banner_username || 'Unknown',
    createdAt: r.created_at * 1000,
  }))

  return c.json({ bans })
})

banRoutes.post('/:userId', authMiddleware, (c) => {
  const user = getAuth(c)
  const targetUserId = c.req.param('userId') || ''
  const db = getDb()

  if (!hasPermissionForUser(user.userId, 'ban_members')) {
    return c.json({ error: 'You do not have permission to ban members' }, 403)
  }
  if (targetUserId === user.userId) return c.json({ error: 'Cannot ban yourself' }, 400)

  const member = db.prepare('SELECT * FROM server_members WHERE user_id = ?').get(targetUserId) as any
  if (!member) return c.json({ error: 'Member not found' }, 404)
  if (member.is_host) return c.json({ error: 'Cannot ban the host' }, 403)

  const targetInfo = getUserInfo(targetUserId)
  if (targetInfo && targetInfo.role === 'admin' && !isUserAdmin(user.userId)) {
    return c.json({ error: 'Cannot ban an admin' }, 403)
  }

  const existing = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(targetUserId) as any
  if (existing) return c.json({ error: 'User is already banned' }, 400)

  let reason = null
  try {
    const body = c.req.json() as any
    reason = body?.reason || null
  } catch {}

  const id = uuidv4()
  db.prepare('INSERT INTO bans (id, user_id, banned_by, reason) VALUES (?, ?, ?, ?)').run(id, targetUserId, user.userId, reason)
  db.prepare('DELETE FROM server_members WHERE user_id = ?').run(targetUserId)
  try { const io: any = c.get('io' as never); if (io) io.emit('member:removed', { userId: targetUserId }) } catch {}

  logAuditEvent(db, 'member_ban', user.userId, targetUserId, JSON.stringify({ reason }))

  return c.json({ success: true, id })
})

banRoutes.delete('/:userId', authMiddleware, (c) => {
  const user = getAuth(c)
  const targetUserId = c.req.param('userId')
  const db = getDb()

  if (!hasPermissionForUser(user.userId, 'ban_members')) {
    return c.json({ error: 'You do not have permission to manage bans' }, 403)
  }

  const ban = db.prepare('SELECT id FROM bans WHERE user_id = ?').get(targetUserId) as any
  if (!ban) return c.json({ error: 'Ban not found' }, 404)

  db.prepare('DELETE FROM bans WHERE user_id = ?').run(targetUserId)

  logAuditEvent(db, 'member_unban', user.userId, targetUserId, null)

  return c.json({ success: true })
})

export default banRoutes
export { banRoutes }
