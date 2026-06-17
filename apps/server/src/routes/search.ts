import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'

const searchRoutes = new Hono()

searchRoutes.get('/', authMiddleware, (c) => {
  const query = c.req.query('query')?.trim()
  if (!query || query.length < 2) {
    return c.json({ results: [], hasMore: false })
  }

  const channelId = c.req.query('channelId')
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 50)
  const before = c.req.query('before')
  const db = getDb()

  const ftsQuery = query.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' ')

  try {
    let rows: any[]
    if (before) {
      rows = db.prepare(`
        SELECT m.*, u.display_name, u.avatar, c.name as channel_name
        FROM messages_fts f
        JOIN messages m ON f.rowid = m.rowid
        LEFT JOIN users u ON m.author_id = u.id
        LEFT JOIN channels c ON m.channel_id = c.id
        WHERE messages_fts MATCH ?
        AND m.rowid < (SELECT rowid FROM messages WHERE id = ?)
        ${channelId ? 'AND m.channel_id = ?' : ''}
        ORDER BY m.rowid DESC
        LIMIT ?
      `).all(ftsQuery, before, ...(channelId ? [channelId, limit] : [limit])) as any[]
      rows = rows.reverse()
    } else {
      rows = db.prepare(`
        SELECT m.*, u.display_name, u.avatar, c.name as channel_name
        FROM messages_fts f
        JOIN messages m ON f.rowid = m.rowid
        LEFT JOIN users u ON m.author_id = u.id
        LEFT JOIN channels c ON m.channel_id = c.id
        WHERE messages_fts MATCH ?
        ${channelId ? 'AND m.channel_id = ?' : ''}
        ORDER BY m.rowid DESC
        LIMIT ?
      `).all(ftsQuery, ...(channelId ? [channelId, limit] : [limit])) as any[]
      rows = rows.reverse()
    }

    const results = rows.map(r => ({
      message: {
        id: r.id,
        channel_id: r.channel_id,
        user_id: r.author_id,
        username: r.author_username,
        display_name: r.display_name || r.author_username,
        avatar: r.avatar || undefined,
        content: r.content,
        created_at: r.created_at * 1000,
      },
      channelName: r.channel_name || 'Unknown',
    }))

    const hasMore = rows.length === limit

    return c.json({ results, hasMore })
  } catch {
    return c.json({ results: [], hasMore: false })
  }
})

export default searchRoutes
export { searchRoutes }
