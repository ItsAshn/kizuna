import { Hono } from 'hono'
import type { Context } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'

interface AuthUser { userId: string; username: string; role: string }

interface IOServer {
  emit(event: string, data: unknown): void
  to(room: string): IOServer
}
function getAuth(c: Context): AuthUser { return c.get('auth' as never) as AuthUser }

const mutesRoutes = new Hono()

mutesRoutes.get('/', authMiddleware, async (c) => {
  const { userId } = getAuth(c)
  const db = getDb()
  const rows = db.prepare(
    `SELECT channel_id, muted_until FROM channel_mutes
     WHERE user_id = ? AND (muted_until IS NULL OR muted_until > unixepoch())`
  ).all(userId) as { channel_id: string; muted_until: number | null }[]

  const mutes = rows.map((r) => ({
    channel_id: r.channel_id,
    muted_until: r.muted_until ? r.muted_until * 1000 : null,
  }))

  return c.json({ mutes })
})

mutesRoutes.put('/:channelId', authMiddleware, async (c) => {
  const { userId } = getAuth(c)
  const { channelId } = c.req.param()
  const body = await c.req.json() as { muted_until: number | null }

  const mutedUntil = body.muted_until
    ? Math.floor(body.muted_until / 1000)
    : null

  const db = getDb()
  db.prepare(
    `INSERT INTO channel_mutes (user_id, channel_id, muted_until)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET muted_until = excluded.muted_until`
  ).run(userId, channelId, mutedUntil)

  const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
  if (io) {
    io.to(`user:${userId}`).emit('channel:mute', {
      channel_id: channelId,
      muted_until: body.muted_until,
    })
  }

  return c.json({
    mute: {
      channel_id: channelId,
      muted_until: body.muted_until,
    },
  })
})

mutesRoutes.delete('/:channelId', authMiddleware, async (c) => {
  const { userId } = getAuth(c)
  const { channelId } = c.req.param()

  const db = getDb()
  db.prepare('DELETE FROM channel_mutes WHERE user_id = ? AND channel_id = ?').run(userId, channelId)

  const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
  if (io) {
    io.to(`user:${userId}`).emit('channel:unmute', { channel_id: channelId })
  }

  return c.json({ ok: true })
})

export default mutesRoutes
