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
    let beforeRowId: number | null = null
    if (before) {
      const cursor = db.prepare('SELECT rowid FROM messages_fts WHERE message_id = ?').get(before) as { rowid: number } | undefined
      if (cursor) beforeRowId = cursor.rowid
    }

    const params: (string | number)[] = [ftsQuery]

    let channelFilter = ''
    if (channelId) {
      channelFilter = `AND ((f.source = 'channel' AND m.channel_id = ?) OR (f.source = 'dm' AND dm.channel_id = ?))`
      params.push(channelId, channelId)
    }

    let beforeFilter = ''
    if (beforeRowId !== null) {
      beforeFilter = 'AND f.rowid < ?'
      params.push(beforeRowId)
    }

    params.push(limit + 1)

    const rows = db.prepare(`
      SELECT
        f.source,
        f.message_id,
        f.rowid as fts_rowid,
        COALESCE(m.id, dm.id) as id,
        COALESCE(m.channel_id, dm.channel_id) as channel_id,
        COALESCE(m.author_id, dm.from_id) as author_id,
        COALESCE(m.author_username, dm.from_username) as author_username,
        COALESCE(m.content, dm.content) as content,
        COALESCE(m.created_at, dm.created_at) as created_at,
        u.display_name,
        u.avatar,
        c.name as channel_name
      FROM messages_fts f
      LEFT JOIN messages m ON f.message_id = m.id AND f.source = 'channel'
      LEFT JOIN direct_messages dm ON f.message_id = dm.id AND f.source = 'dm'
      LEFT JOIN users u ON (f.source = 'channel' AND m.author_id = u.id) OR (f.source = 'dm' AND dm.from_id = u.id)
      LEFT JOIN channels c ON f.source = 'channel' AND m.channel_id = c.id
      WHERE messages_fts MATCH ?
      ${beforeFilter}
      ${channelFilter}
      ORDER BY f.rowid DESC
      LIMIT ?
    `).all(...params) as any[]

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    const results = rows.map((r: any) => ({
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
      channelName: r.channel_name || 'DM',
    }))

    return c.json({ results, hasMore })
  } catch {
    return c.json({ results: [], hasMore: false })
  }
})

export default searchRoutes
export { searchRoutes }
