import { Hono } from 'hono'
import type { Context } from 'hono'
import type Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db'
import { authMiddleware, adminMiddleware, getUserPermissions, hasPermission } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'

interface IOServer {
  to(room: string): { emit(event: string, data: unknown): void }
  emit(event: string, data: unknown): void
}

interface GroupDMChannelRow {
  id: string
  name: string
  owner_id: string
  avatar: string | null
  last_message_at: number | null
  created_at: number
}

interface GroupDMMessageWithOwner {
  id: string
  channel_id: string
  from_id: string
  from_username: string
  content: string
  encrypted: number
  edited_at: number | null
  created_at: number
  reply_to_message_id: string | null
  reply_to_username: string | null
  reply_to_content: string | null
  owner_id: string
}

function getAuth(c: Context): AuthUser { return c.get('auth' as never) as AuthUser }

function getMaxMembers(): number {
  return parseInt(process.env.GROUP_DM_MAX_MEMBERS || '10', 10) || 10
}

function formatGroupDMChannel(db: Database.Database, channel: GroupDMChannelRow) {
  const members = db.prepare(`
    SELECT u.id as user_id, u.username, u.display_name, u.avatar, u.public_key, gm.joined_at
    FROM group_dm_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.channel_id = ?
    ORDER BY gm.joined_at ASC
  `).all(channel.id) as { user_id: string; username: string; display_name: string; avatar: string | null; public_key: string | null; joined_at: number }[]

  return {
    id: channel.id,
    name: channel.name,
    owner_id: channel.owner_id,
    avatar: channel.avatar || null,
    members: members.map((m) => ({
      user_id: m.user_id,
      username: m.username,
      display_name: m.display_name || m.username,
      avatar: m.avatar || null,
      public_key: m.public_key || null,
      joined_at: m.joined_at * 1000,
    })),
    created_at: channel.created_at * 1000,
    last_message_at: channel.last_message_at ? channel.last_message_at * 1000 : null,
  }
}

function isGroupDMMember(db: Database.Database, channelId: string, userId: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
  ).get(channelId, userId)
  return !!row
}

const groupDmRoutes = new Hono()

// GET /group-dms — list group DM channels for the authenticated user
groupDmRoutes.get('/', authMiddleware, (c) => {
  const user = getAuth(c)
  const db = getDb()
  const channels = db.prepare(`
    SELECT gdc.* FROM group_dm_channels gdc
    JOIN group_dm_members gdm ON gdm.channel_id = gdc.id
    WHERE gdm.user_id = ?
    ORDER BY gdc.last_message_at DESC
  `).all(user.userId) as GroupDMChannelRow[]

  const result = channels.map((ch) => formatGroupDMChannel(db, ch))
  return c.json({ channels: result })
})

// POST /group-dms — create a group DM
groupDmRoutes.post('/', authMiddleware, async (c) => {
  const user = getAuth(c)
  const body = await c.req.json() as { name: string; memberIds: string[] }
  const { name, memberIds } = body

  if (!name?.trim()) return c.json({ error: 'Group name is required' }, 400)
  if (!memberIds || !Array.isArray(memberIds) || memberIds.length < 2) {
    return c.json({ error: 'At least 2 members are required' }, 400)
  }

  const maxMembers = getMaxMembers()
  const uniqueIds = [...new Set([...memberIds, user.userId])]
  if (uniqueIds.length > maxMembers) {
    return c.json({ error: `Maximum ${maxMembers} members allowed` }, 400)
  }

  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'create_group_dms')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const db = getDb()

  for (const memberId of uniqueIds) {
    const memberRow = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(memberId)
    if (!memberRow) {
      return c.json({ error: `User ${memberId} is not a server member` }, 400)
    }
  }

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)

  db.prepare(
    'INSERT INTO group_dm_channels (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, name.trim(), user.userId, now)

  const insertMember = db.prepare(
    'INSERT INTO group_dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)'
  )
  for (const memberId of uniqueIds) {
    insertMember.run(id, memberId, now)
  }

  const channel = db.prepare('SELECT * FROM group_dm_channels WHERE id = ?').get(id) as GroupDMChannelRow
  const formatted = formatGroupDMChannel(db, channel)

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      for (const memberId of uniqueIds) {
        io.to(`group-dm:${memberId}`).emit('group-dm:channel-created', formatted)
      }
    }
  } catch { /* best-effort */ }

  return c.json({ channel: formatted }, 201)
})

// GET /group-dms/:channelId — get group DM details
groupDmRoutes.get('/:channelId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const db = getDb()

  const channel = db.prepare('SELECT * FROM group_dm_channels WHERE id = ?').get(channelId) as GroupDMChannelRow | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  if (!isGroupDMMember(db, channelId, user.userId)) {
    return c.json({ error: 'Not a member' }, 403)
  }

  return c.json({ channel: formatGroupDMChannel(db, channel) })
})

// PATCH /group-dms/:channelId — update group DM name/avatar
groupDmRoutes.patch('/:channelId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const body = await c.req.json() as { name?: string; avatar?: string | null }
  const db = getDb()

  const channel = db.prepare('SELECT * FROM group_dm_channels WHERE id = ?').get(channelId) as GroupDMChannelRow | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  if (channel.owner_id !== user.userId) {
    return c.json({ error: 'Only the owner can update the group' }, 403)
  }

  if (body.name !== undefined) {
    if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400)
    db.prepare('UPDATE group_dm_channels SET name = ? WHERE id = ?').run(body.name.trim(), channelId)
  }
  if (body.avatar !== undefined) {
    db.prepare('UPDATE group_dm_channels SET avatar = ? WHERE id = ?').run(body.avatar || null, channelId)
  }

  const updated = db.prepare('SELECT * FROM group_dm_channels WHERE id = ?').get(channelId) as GroupDMChannelRow
  const formatted = formatGroupDMChannel(db, updated)

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      const members = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
      ).all(channelId) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('group-dm:channel-updated', formatted)
      }
    }
  } catch { /* best-effort */ }

  return c.json({ channel: formatted })
})

// GET /group-dms/:channelId/messages
groupDmRoutes.get('/:channelId/messages', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100)
  const before = c.req.query('before')
  const db = getDb()

  if (!isGroupDMMember(db, channelId, user.userId)) {
    return c.json({ error: 'Not a member' }, 403)
  }

  let rows: { id: string; channel_id: string; from_id: string; from_username: string; content: string; encrypted: number; edited_at: number | null; created_at: number; reply_to_message_id: string | null; reply_to_username: string | null; reply_to_content: string | null; display_name: string | null; avatar: string | null; public_key: string | null }[]
  if (before) {
    const anchor = db.prepare('SELECT created_at FROM group_dm_messages WHERE id = ?').get(before) as { created_at: number } | undefined
    rows = anchor
      ? db.prepare(`
          SELECT gdm.*, u.display_name, u.avatar, u.public_key FROM group_dm_messages gdm
          LEFT JOIN users u ON gdm.from_id = u.id
          WHERE gdm.channel_id = ? AND gdm.created_at < ?
          ORDER BY gdm.created_at DESC LIMIT ?
        `).all(channelId, anchor.created_at, limit) as { id: string; channel_id: string; from_id: string; from_username: string; content: string; encrypted: number; edited_at: number | null; created_at: number; reply_to_message_id: string | null; reply_to_username: string | null; reply_to_content: string | null; display_name: string | null; avatar: string | null; public_key: string | null }[]
      : []
    rows = rows.reverse()
  } else {
    rows = db.prepare(`
      SELECT gdm.*, u.display_name, u.avatar, u.public_key FROM group_dm_messages gdm
      LEFT JOIN users u ON gdm.from_id = u.id
      WHERE gdm.channel_id = ?
      ORDER BY gdm.created_at DESC LIMIT ?
    `).all(channelId, limit) as { id: string; channel_id: string; from_id: string; from_username: string; content: string; encrypted: number; edited_at: number | null; created_at: number; reply_to_message_id: string | null; reply_to_username: string | null; reply_to_content: string | null; display_name: string | null; avatar: string | null; public_key: string | null }[]
    rows = rows.reverse()
  }

  const hasMore = rows.length === limit

  const messages = rows.map((row) => ({
    id: row.id,
    channel_id: channelId,
    user_id: row.from_id,
    username: row.from_username,
    display_name: row.display_name || row.from_username,
    avatar: row.avatar || undefined,
    sender_public_key: row.public_key || undefined,
    content: row.content,
    encrypted: row.encrypted,
    created_at: row.created_at * 1000,
  }))

  return c.json({ messages, hasMore })
})

// POST /group-dms/:channelId/messages
groupDmRoutes.post('/:channelId/messages', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const body = await c.req.json() as { content: string; encrypted?: boolean; attachment_ids?: string[] }
  const { content, encrypted, attachment_ids } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  const maxLen = encrypted ? 8000 : 4000
  if (content.length > maxLen) return c.json({ error: 'Message too long' }, 400)

  const db = getDb()
  if (!isGroupDMMember(db, channelId, user.userId)) {
    return c.json({ error: 'Not a member' }, 403)
  }

  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'send_dm_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const id = uuidv4()
  const now = Math.floor(Date.now() / 1000)

  db.prepare(
    'INSERT INTO group_dm_messages (id, channel_id, from_id, from_username, content, encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, channelId, user.userId, user.username, content.trim(), encrypted ? 1 : 0, now)

  if (attachment_ids && attachment_ids.length > 0) {
    const updateStmt = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL')
    const tx = db.transaction(() => {
      for (const attId of attachment_ids) {
        updateStmt.run(id, attId)
      }
    })
    tx()
  }

  db.prepare('UPDATE group_dm_channels SET last_message_at = ? WHERE id = ?').run(now, channelId)

  const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(user.userId) as { display_name: string | null; avatar: string | null } | undefined
  const message = {
    id,
    channel_id: channelId,
    user_id: user.userId,
    username: user.username,
    display_name: userRow?.display_name || user.username,
    avatar: userRow?.avatar || undefined,
    content: content.trim(),
    encrypted: encrypted ? 1 : 0,
    created_at: now * 1000,
  }

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      const members = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ? AND user_id != ?'
      ).all(channelId, user.userId) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('group-dm:received', message)
      }
      io.to(`user:${user.userId}`).emit('group-dm:sent', message)
    }
  } catch { /* best-effort */ }

  return c.json({ message }, 201)
})

// DELETE /group-dms/messages/:messageId
groupDmRoutes.delete('/messages/:messageId', authMiddleware, (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId')
  const db = getDb()

  const gdm = db.prepare(`
    SELECT gdm.*, gdc.owner_id
    FROM group_dm_messages gdm
    JOIN group_dm_channels gdc ON gdc.id = gdm.channel_id
    WHERE gdm.id = ?
  `).get(messageId) as GroupDMMessageWithOwner | undefined
  if (!gdm) return c.json({ error: 'Message not found' }, 404)
  if (gdm.from_id !== user.userId) return c.json({ error: 'Forbidden' }, 403)

  db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(messageId)
  db.prepare('DELETE FROM group_dm_messages WHERE id = ?').run(messageId)

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      const members = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
      ).all(gdm.channel_id) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('group-dm:delete', { id: messageId, channel_id: gdm.channel_id })
      }
    }
  } catch { /* best-effort */ }

  return c.json({ ok: true })
})

// PATCH /group-dms/messages/:messageId
groupDmRoutes.patch('/messages/:messageId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId')
  const body = await c.req.json() as { content: string; encrypted?: boolean }
  const { content, encrypted } = body
  if (!content?.trim()) return c.json({ error: 'Content is required' }, 400)
  const maxLen = encrypted ? 8000 : 4000
  if (content.length > maxLen) return c.json({ error: 'Message too long' }, 400)

  const db = getDb()
  const gdm = db.prepare(`
    SELECT gdm.*, gdc.owner_id
    FROM group_dm_messages gdm
    JOIN group_dm_channels gdc ON gdc.id = gdm.channel_id
    WHERE gdm.id = ?
  `).get(messageId) as GroupDMMessageWithOwner | undefined
  if (!gdm) return c.json({ error: 'Message not found' }, 404)
  if (gdm.from_id !== user.userId) return c.json({ error: 'Forbidden' }, 403)

  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE group_dm_messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), now, messageId)

  const userRow = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(user.userId) as { display_name: string | null; avatar: string | null } | undefined
  const updated = {
    id: gdm.id,
    channel_id: gdm.channel_id,
    user_id: gdm.from_id,
    username: gdm.from_username,
    display_name: userRow?.display_name || gdm.from_username,
    avatar: userRow?.avatar || undefined,
    content: content.trim(),
    encrypted: encrypted ? 1 : 0,
    edited_at: now * 1000,
    created_at: gdm.created_at * 1000,
  }

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      const members = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
      ).all(gdm.channel_id) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('group-dm:edit', updated)
      }
    }
  } catch { /* best-effort */ }

  return c.json({ message: updated })
})

// POST /group-dms/:channelId/members — add a member (owner only)
groupDmRoutes.post('/:channelId/members', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const body = await c.req.json() as { userId: string }
  const { userId } = body
  if (!userId) return c.json({ error: 'User ID is required' }, 400)

  const db = getDb()
  const channel = db.prepare('SELECT * FROM group_dm_channels WHERE id = ?').get(channelId) as GroupDMChannelRow | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  if (channel.owner_id !== user.userId) {
    return c.json({ error: 'Only the owner can add members' }, 403)
  }

  const memberRow = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(userId)
  if (!memberRow) return c.json({ error: 'User is not a server member' }, 400)

  const existing = db.prepare('SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId)
  if (existing) return c.json({ error: 'User is already a member' }, 400)

  const currentCount = db.prepare(
    'SELECT COUNT(*) as count FROM group_dm_members WHERE channel_id = ?'
  ).get(channelId) as { count: number }
  if (currentCount.count >= getMaxMembers()) {
    return c.json({ error: `Maximum ${getMaxMembers()} members reached` }, 400)
  }

  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO group_dm_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)').run(channelId, userId, now)

  const formatted = formatGroupDMChannel(db, channel)

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      const members = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
      ).all(channelId) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('group-dm:channel-updated', formatted)
      }
    }
  } catch { /* best-effort */ }

  return c.json({ channel: formatted })
})

// DELETE /group-dms/:channelId/members/:userId — remove a member or leave
groupDmRoutes.delete('/:channelId/members/:userId', authMiddleware, (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')!
  const targetUserId = c.req.param('userId')
  const db = getDb()

  const channel = db.prepare('SELECT * FROM group_dm_channels WHERE id = ?').get(channelId) as GroupDMChannelRow | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)

  const isSelf = targetUserId === user.userId
  const isOwner = channel.owner_id === user.userId

  if (!isSelf && !isOwner) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  if (isOwner && isSelf) {
    // Owner is leaving — delete the entire group
    const allMembers = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    db.prepare('DELETE FROM group_dm_reads WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM group_dm_voice_participants WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM group_dm_messages WHERE channel_id = ?)').run(channelId)
    db.prepare('DELETE FROM group_dm_messages WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM group_dm_members WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM group_dm_channels WHERE id = ?').run(channelId)

    try {
      const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
      if (io) {
        for (const m of allMembers) {
          io.to(`group-dm:${m.user_id}`).emit('group-dm:channel-deleted', { channel_id: channelId })
        }
      }
    } catch { /* best-effort */ }

    return c.json({ ok: true })
  }

  // Remove specific member (owner or self)
  const memberExists = db.prepare(
    'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
  ).get(channelId, targetUserId)
  if (!memberExists) return c.json({ error: 'User is not a member' }, 404)

  db.prepare('DELETE FROM group_dm_members WHERE channel_id = ? AND user_id = ?').run(channelId, targetUserId)

  try {
    const io: IOServer | undefined = c.get('io' as never) as IOServer | undefined
    if (io) {
      io.to(`group-dm:${targetUserId}`).emit('group-dm:member-removed', { channel_id: channelId, user_id: targetUserId })

      const remainingMembers = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
      ).all(channelId) as { user_id: string }[]

      for (const m of remainingMembers) {
        io.to(`group-dm:${m.user_id}`).emit('group-dm:member-left', { channel_id: channelId, user_id: targetUserId })
      }
    }
  } catch { /* best-effort */ }

  return c.json({ ok: true })
})

// GET /admin/group-dms/stats — admin analytics
const adminGroupDmRoutes = new Hono()

adminGroupDmRoutes.get('/stats', authMiddleware, adminMiddleware, (c) => {
  const db = getDb()
  const period = c.req.query('period') || '30d'
  const now = Math.floor(Date.now() / 1000)
  const periodSecs: Record<string, number> = {
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  }
  const since = now - (periodSecs[period] ?? periodSecs['30d']!)

  const totalChannels = db.prepare(
    'SELECT COUNT(*) as count FROM group_dm_channels'
  ).get() as { count: number }

  const totalMembers = db.prepare(
    'SELECT COUNT(*) as count FROM group_dm_members'
  ).get() as { count: number }

  const activeSessions = db.prepare(
    'SELECT COUNT(*) as count FROM group_dm_voice_participants WHERE left_at IS NULL'
  ).get() as { count: number }

  let voiceMinutes24h = 0
  let voiceMinutes7d = 0
  let voiceMinutes30d = 0

  const mins24h = db.prepare(`
    SELECT COALESCE(SUM((COALESCE(left_at, ?) - joined_at)), 0) as secs
    FROM group_dm_voice_participants
    WHERE left_at IS NOT NULL AND left_at >= ?
  `).get(now, now - 86400) as { secs: number }
  voiceMinutes24h = Math.round(mins24h.secs / 60)

  const mins7d = db.prepare(`
    SELECT COALESCE(SUM((COALESCE(left_at, ?) - joined_at)), 0) as secs
    FROM group_dm_voice_participants
    WHERE left_at IS NOT NULL AND left_at >= ?
  `).get(now, now - 604800) as { secs: number }
  voiceMinutes7d = Math.round(mins7d.secs / 60)

  const mins30d = db.prepare(`
    SELECT COALESCE(SUM((COALESCE(left_at, ?) - joined_at)), 0) as secs
    FROM group_dm_voice_participants
    WHERE left_at IS NOT NULL AND left_at >= ?
  `).get(now, now - 2592000) as { secs: number }
  voiceMinutes30d = Math.round(mins30d.secs / 60)

  const topUsers = db.prepare(`
    SELECT
      gvp.user_id,
      u.username,
      u.display_name,
      CAST(SUM(COALESCE(gvp.left_at, ?) - gvp.joined_at) / 60 AS INTEGER) as minutes
    FROM group_dm_voice_participants gvp
    JOIN users u ON u.id = gvp.user_id
    WHERE gvp.left_at IS NOT NULL AND gvp.left_at >= ?
    GROUP BY gvp.user_id
    ORDER BY minutes DESC
    LIMIT 20
  `).all(now, since) as { user_id: string; username: string; display_name: string; minutes: number }[]

  return c.json({
    stats: {
      total_channels: totalChannels.count,
      total_members: totalMembers.count,
      active_voice_sessions: activeSessions.count,
      voice_minutes_24h: voiceMinutes24h,
      voice_minutes_7d: voiceMinutes7d,
      voice_minutes_30d: voiceMinutes30d,
      top_users_by_voice: topUsers,
    },
  })
})

export { groupDmRoutes, adminGroupDmRoutes }
