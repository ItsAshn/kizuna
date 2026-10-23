import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware, getViewableChannelIds } from '../middleware/auth'
import { searchSchema } from '../utils/schemas'
import type { AuthUser } from '../middleware/auth'

const searchRoutes = new Hono()

interface SearchRow {
  source: 'channel' | 'dm' | 'group_dm'
  id: string
  channel_id: string
  author_id: string
  author_username: string
  content: string
  created_at: number
  display_name: string | null
  avatar: string | null
  channel_name: string | null
}

searchRoutes.get('/', authMiddleware, (c) => {
  const auth = c.get('auth' as never) as AuthUser
  const parsed = searchSchema.safeParse(c.req.query())
  if (!parsed.success) {
    return c.json({ results: [], hasMore: false })
  }

  const { query: q, channel_id: channelId, before, limit: rawLimit } = parsed.data
  const limit = Math.min(rawLimit ?? 20, 50)
  const db = getDb()

  // Quote each word so FTS5 operators in user input are taken literally.
  const ftsQuery = q
    .replace(/[^\p{L}\p{N}\s_]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"`)
    .join(' ')
  if (!ftsQuery) return c.json({ results: [], hasMore: false })

  try {
    // Keyset cursor on (created_at, id) across all three message tables.
    let cursor: { created_at: number; id: string } | undefined
    if (before) {
      cursor = db
        .prepare(
          `SELECT created_at, id FROM messages WHERE id = ?
           UNION ALL SELECT created_at, id FROM direct_messages WHERE id = ?
           UNION ALL SELECT created_at, id FROM group_dm_messages WHERE id = ?
           LIMIT 1`,
        )
        .get(before, before, before) as { created_at: number; id: string } | undefined
      if (!cursor) return c.json({ results: [], hasMore: false })
    }

    // Visibility is applied in SQL so a page is never padded out with rows the
    // caller can't see, which keeps LIMIT (and therefore hasMore) honest.
    const viewable = JSON.stringify([...getViewableChannelIds(auth.userId)])
    const channelFilter = (col: string) => (channelId ? `AND ${col} = ?` : '')
    const channelParam = channelId ? [channelId] : []

    const params: (string | number | null)[] = [
      ftsQuery,
      viewable,
      ...channelParam,
      ftsQuery,
      auth.userId,
      auth.userId,
      ...channelParam,
      ftsQuery,
      auth.userId,
      ...channelParam,
      cursor ? cursor.created_at : null,
      cursor ? cursor.created_at : null,
      cursor ? cursor.created_at : null,
      cursor ? cursor.id : null,
      limit + 1,
    ]

    const rows = db
      .prepare(
        `
      SELECT * FROM (
        SELECT 'channel' AS source, m.id, m.channel_id, m.author_id, m.author_username,
               m.content, m.created_at, u.display_name, u.avatar, c.name AS channel_name
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        LEFT JOIN users u ON u.id = m.author_id
        LEFT JOIN channels c ON c.id = m.channel_id
        WHERE messages_fts MATCH ?
          AND m.channel_id IN (SELECT value FROM json_each(?))
          ${channelFilter('m.channel_id')}

        UNION ALL

        SELECT 'dm', dm.id, dm.channel_id, dm.from_id, dm.from_username,
               dm.content, dm.created_at, u.display_name, u.avatar, NULL
        FROM dm_messages_fts
        JOIN direct_messages dm ON dm.rowid = dm_messages_fts.rowid
        LEFT JOIN users u ON u.id = dm.from_id
        WHERE dm_messages_fts MATCH ?
          AND (dm.from_id = ? OR dm.to_id = ?)
          ${channelFilter('dm.channel_id')}

        UNION ALL

        SELECT 'group_dm', gdm.id, gdm.channel_id, gdm.from_id, gdm.from_username,
               gdm.content, gdm.created_at, u.display_name, u.avatar, gdc.name
        FROM group_dm_messages_fts
        JOIN group_dm_messages gdm ON gdm.rowid = group_dm_messages_fts.rowid
        LEFT JOIN users u ON u.id = gdm.from_id
        LEFT JOIN group_dm_channels gdc ON gdc.id = gdm.channel_id
        WHERE group_dm_messages_fts MATCH ?
          AND EXISTS (SELECT 1 FROM group_dm_members gm
                      WHERE gm.channel_id = gdm.channel_id AND gm.user_id = ?)
          ${channelFilter('gdm.channel_id')}
      )
      WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
      )
      .all(...params) as SearchRow[]

    // One extra row was fetched purely to learn whether another page exists.
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const results = page.map((r) => ({
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
  } catch (err) {
    console.error('[search] query failed:', err instanceof Error ? err.message : err)
    return c.json({ results: [], hasMore: false })
  }
})

export default searchRoutes
export { searchRoutes }
