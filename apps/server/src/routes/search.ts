import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { searchSchema } from '../utils/schemas'
import type { AuthUser } from '../middleware/auth'

const searchRoutes = new Hono()

searchRoutes.get('/', authMiddleware, (c) => {
  const auth = c.get('auth' as never) as AuthUser
  const parsed = searchSchema.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ results: [], hasMore: false })
  }

  const { query: q, channel_id: channelId, before, limit: rawLimit } = parsed.data
  const limit = Math.min(rawLimit ?? 20, 50)
  const db = getDb()

  const ftsQuery = q.replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean).map(w => `"${w}"`).join(' ')

  try {
    let beforeRowId: number | null = null
    if (before) {
      const cursor = db.prepare('SELECT rowid FROM messages_fts WHERE message_id = ?').get(before) as { rowid: number } | undefined
      if (cursor) beforeRowId = cursor.rowid
    }

    const params: (string | number)[] = [ftsQuery]

    params.push(auth.userId)                 // permission: server member
    params.push(auth.userId)                 // permission: dm from
    params.push(auth.userId)                 // permission: dm to
    params.push(auth.userId)                 // permission: group_dm member

    let channelFilter = ''
    if (channelId) {
      channelFilter = `AND ((f.source = 'channel' AND m.channel_id = ?) OR (f.source = 'dm' AND dm.channel_id = ?) OR (f.source = 'group_dm' AND gdm.channel_id = ?))`
      params.push(channelId, channelId, channelId)
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
        COALESCE(m.id, dm.id, gdm.id) as id,
        COALESCE(m.channel_id, dm.channel_id, gdm.channel_id) as channel_id,
        COALESCE(m.author_id, dm.from_id, gdm.from_id) as author_id,
        COALESCE(m.author_username, dm.from_username, gdm.from_username) as author_username,
        COALESCE(m.content, dm.content, gdm.content) as content,
        COALESCE(m.created_at, dm.created_at, gdm.created_at) as created_at,
        u.display_name,
        u.avatar,
        COALESCE(c.name, gdc.name) as channel_name
      FROM messages_fts f
      LEFT JOIN messages m ON f.message_id = m.id AND f.source = 'channel'
      LEFT JOIN direct_messages dm ON f.message_id = dm.id AND f.source = 'dm'
      LEFT JOIN group_dm_messages gdm ON f.message_id = gdm.id AND f.source = 'group_dm'
      LEFT JOIN users u ON
        (f.source = 'channel' AND m.author_id = u.id) OR
        (f.source = 'dm' AND dm.from_id = u.id) OR
        (f.source = 'group_dm' AND gdm.from_id = u.id)
      LEFT JOIN channels c ON f.source = 'channel' AND m.channel_id = c.id
      LEFT JOIN group_dm_channels gdc ON f.source = 'group_dm' AND gdm.channel_id = gdc.id
      WHERE messages_fts MATCH ?
        AND (
          f.source != 'channel' OR c.locked = 0 OR EXISTS (SELECT 1 FROM server_members sm WHERE sm.user_id = ?)
        )
        AND (
          f.source != 'dm' OR dm.from_id = ? OR dm.to_id = ?
        )
        AND (
          f.source != 'group_dm' OR EXISTS (SELECT 1 FROM group_dm_members gdm_m WHERE gdm_m.channel_id = gdm.channel_id AND gdm_m.user_id = ?)
        )
      ${beforeFilter}
      ${channelFilter}
      ORDER BY f.rowid DESC
      LIMIT ?
    `).all(...params) as {
    source: string
    message_id: string
    fts_rowid: number
    id: string
    channel_id: string
    author_id: string
    author_username: string
    content: string
    created_at: number
    display_name: string | null
    avatar: string | null
    channel_name: string | null
  }[]

    const hasMore = rows.length > limit
    if (hasMore) rows.pop()

    const results = rows.map((r: {
    source: string; id: string; channel_id: string; author_id: string;
    author_username: string; display_name: string | null; avatar: string | null;
    content: string; created_at: number; channel_name: string | null
  }) => ({
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
      channelName: r.channel_name || (r.source === 'group_dm' ? 'Group DM' : 'DM'),
    }))

    return c.json({ results, hasMore })
  } catch {
    return c.json({ results: [], hasMore: false })
  }
})

export default searchRoutes
export { searchRoutes }
