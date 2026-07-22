import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware, hasPermission, getUserPermissions, isUserAdmin, canViewChannel } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import { getAuth } from '../utils/auth'
import { getIo } from '../utils/io'

const pollsRouter = new Hono()

// Maximum poll duration: 30 days.
const MAX_DURATION_SECONDS = 60 * 60 * 24 * 30

interface PollCreateInput {
  question: string
  options: string[]
  durationSeconds: number | null
  allowMultiple: boolean
}

/** Validate and normalise a poll create request body. Returns an error string if invalid. */
function parsePollBody(body: unknown): PollCreateInput | string {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b.question !== 'string' || !b.question.trim() || !Array.isArray(b.options) || b.options.length < 2) {
    return 'question and at least 2 options required'
  }
  const question = b.question.trim().slice(0, 300)
  const options: string[] = b.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 10)
  if (options.length < 2) return 'need at least 2 non-empty options'

  let durationSeconds: number | null = null
  if (typeof b.durationSeconds === 'number' && Number.isFinite(b.durationSeconds) && b.durationSeconds > 0) {
    durationSeconds = Math.min(Math.floor(b.durationSeconds), MAX_DURATION_SECONDS)
  }
  const allowMultiple = b.allowMultiple === true

  return { question, options, durationSeconds, allowMultiple }
}

/** Insert a poll + its options and return the socket-ready payload. */
function insertPoll(
  db: ReturnType<typeof getDb>,
  input: PollCreateInput,
  meta: { channelId: string; channelType: string; userId: string; username: string },
) {
  const { question, options, durationSeconds, allowMultiple } = input
  const { channelId, channelType, userId, username } = meta
  const pollId = uuidv4()
  const now = Math.floor(Date.now() / 1000)
  const closesAt = durationSeconds ? now + durationSeconds : null

  const author = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as { display_name: string; avatar: string | null } | undefined

  db.prepare(
    `INSERT INTO polls (id, channel_id, channel_type, message_id, question, allow_multiple, closes_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(pollId, channelId, channelType, pollId, question, allowMultiple ? 1 : 0, closesAt, userId, now)

  const dbOptions: { id: string; label: string; position: number; vote_count: number }[] = []
  options.forEach((label, i) => {
    const optId = uuidv4()
    db.prepare(`INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)`).run(optId, pollId, label, i)
    dbOptions.push({ id: optId, label, position: i, vote_count: 0 })
  })

  return {
    pollId,
    channelId,
    channelType,
    question,
    options: dbOptions,
    createdBy: userId,
    createdByDisplayName: author?.display_name ?? username,
    createdByAvatar: author?.avatar ?? null,
    createdAt: now * 1000,
    closesAt: closesAt ? closesAt * 1000 : null,
    allowMultiple,
  }
}

/** Build the full poll list (with vote counts + the requester's votes) for a channel. */
function listChannelPolls(db: ReturnType<typeof getDb>, channelId: string, channelType: string, userId: string) {
  const rows = db.prepare(
    'SELECT * FROM polls WHERE channel_id = ? AND channel_type = ? ORDER BY created_at DESC',
  ).all(channelId, channelType) as {
    id: string; question: string; created_by: string; created_at: number
    closes_at: number | null; allow_multiple: number
  }[]

  return rows.map((poll) => {
    const options = db.prepare(`
      SELECT po.id, po.label, po.position, COUNT(pv.id) as vote_count
      FROM poll_options po
      LEFT JOIN poll_votes pv ON pv.option_id = po.id
      WHERE po.poll_id = ?
      GROUP BY po.id ORDER BY po.position
    `).all(poll.id) as { id: string; label: string; position: number; vote_count: number }[]

    const author = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(poll.created_by) as { display_name: string; avatar: string | null } | undefined
    const userVotes = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(poll.id, userId) as { option_id: string }[]

    return {
      pollId: poll.id,
      channelId,
      channelType,
      question: poll.question,
      options,
      createdBy: poll.created_by,
      createdByDisplayName: author?.display_name ?? 'Unknown',
      createdByAvatar: author?.avatar ?? null,
      createdAt: poll.created_at * 1000,
      closesAt: poll.closes_at ? poll.closes_at * 1000 : null,
      allowMultiple: !!poll.allow_multiple,
      userVoteIds: userVotes.map((v) => v.option_id),
    }
  })
}

// Create a poll in a guild channel
pollsRouter.post('/channels/:channelId/polls', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param() as { channelId: string }
  const { userId, username } = getAuth(c)
  const input = parsePollBody(await c.req.json().catch(() => null))
  if (typeof input === 'string') return c.json({ error: input }, 400)

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as Record<string, unknown> | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  const userPerms = getUserPermissions(userId)
  if (!userPerms || !hasPermission(userPerms, 'send_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const pollData = insertPoll(db, input, { channelId, channelType: 'channel', userId, username })

  const io = getIo(c)
  io?.to(channelId).emit('poll:created', pollData)

  return c.json({ poll: { id: pollData.pollId, question: pollData.question, options: pollData.options } })
})

// List polls in a guild channel
pollsRouter.get('/channels/:channelId/polls', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param() as { channelId: string }
  const { userId } = getAuth(c)

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId)
  if (!channel) return c.json({ error: 'Channel not found' }, 404)
  if (!canViewChannel(userId, channelId)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  return c.json({ polls: listChannelPolls(db, channelId, 'channel', userId) })
})

// Create a poll in a DM channel
pollsRouter.post('/dms/channel/:channelId/polls', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param() as { channelId: string }
  const { userId, username } = getAuth(c)
  const input = parsePollBody(await c.req.json().catch(() => null))
  if (typeof input === 'string') return c.json({ error: input }, 400)

  const channel = db.prepare('SELECT * FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)').get(channelId, userId, userId) as Record<string, unknown> | undefined
  if (!channel) return c.json({ error: 'Channel not found' }, 404)

  const userPerms = getUserPermissions(userId)
  if (!userPerms || !hasPermission(userPerms, 'send_dm_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const toId = channel.user1_id === userId ? (channel.user2_id as string) : (channel.user1_id as string)

  const pollData = insertPoll(db, input, { channelId, channelType: 'dm', userId, username })

  try {
    const io = getIo(c)
    if (io) {
      io.to(`dm:${toId}`).emit('poll:created', pollData)
      io.to(`user:${userId}`).emit('poll:created', pollData)
    }
  } catch { /* best-effort */ }

  return c.json({ poll: { id: pollData.pollId, question: pollData.question, options: pollData.options } })
})

// List polls in a DM channel
pollsRouter.get('/dms/channel/:channelId/polls', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param() as { channelId: string }
  const { userId } = getAuth(c)

  const channel = db.prepare('SELECT * FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)').get(channelId, userId, userId)
  if (!channel) return c.json({ error: 'Channel not found' }, 404)

  return c.json({ polls: listChannelPolls(db, channelId, 'dm', userId) })
})

// Create a poll in a group DM channel
pollsRouter.post('/group-dms/:channelId/polls', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param() as { channelId: string }
  const { userId, username } = getAuth(c)
  const input = parsePollBody(await c.req.json().catch(() => null))
  if (typeof input === 'string') return c.json({ error: input }, 400)

  if (!db.prepare('SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId)) {
    return c.json({ error: 'Not a member' }, 403)
  }

  const userPerms = getUserPermissions(userId)
  if (!userPerms || !hasPermission(userPerms, 'send_dm_messages')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const pollData = insertPoll(db, input, { channelId, channelType: 'group-dm', userId, username })

  try {
    const io = getIo(c)
    if (io) {
      const members = db.prepare(
        'SELECT user_id FROM group_dm_members WHERE channel_id = ? AND user_id != ?'
      ).all(channelId, userId) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('poll:created', pollData)
      }
      io.to(`user:${userId}`).emit('poll:created', pollData)
    }
  } catch { /* best-effort */ }

  return c.json({ poll: { id: pollData.pollId, question: pollData.question, options: pollData.options } })
})

// List polls in a group DM channel
pollsRouter.get('/group-dms/:channelId/polls', authMiddleware, async (c) => {
  const db = getDb()
  const { channelId } = c.req.param() as { channelId: string }
  const { userId } = getAuth(c)

  if (!db.prepare('SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId)) {
    return c.json({ error: 'Not a member' }, 403)
  }

  return c.json({ polls: listChannelPolls(db, channelId, 'group-dm', userId) })
})

// Get poll with vote counts
pollsRouter.get('/polls/:pollId', authMiddleware, async (c) => {
  const db = getDb()
  const { pollId } = c.req.param()
  const { userId } = getAuth(c)

  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId) as {
    id: string; channel_id: string; channel_type: string; message_id: string; question: string
    created_by: string; created_at: number; closes_at: number | null; allow_multiple: number
  } | undefined
  if (!poll) return c.json({ error: 'not found' }, 404)

  const options = db.prepare(`
    SELECT po.id, po.label, po.position,
      COUNT(pv.id) as vote_count
    FROM poll_options po
    LEFT JOIN poll_votes pv ON pv.option_id = po.id
    WHERE po.poll_id = ?
    GROUP BY po.id ORDER BY po.position
  `).all(pollId) as { id: string; label: string; position: number; vote_count: number }[]

  const userVotes = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(pollId, userId) as { option_id: string }[]
  const userVoteIds = new Set(userVotes.map(v => v.option_id))

  return c.json({ poll: { ...poll, options, userVoteIds: [...userVoteIds] } })
})

// Vote on a poll
pollsRouter.post('/polls/:pollId/vote', authMiddleware, async (c) => {
  const db = getDb()
  const { pollId } = c.req.param()
  const { userId } = getAuth(c)
  const body = await c.req.json().catch(() => null)
  if (!body?.optionId) return c.json({ error: 'optionId required' }, 400)

  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId) as {
    id: string; channel_id: string; channel_type: string; message_id: string; question: string
    created_by: string; created_at: number; closes_at: number | null; allow_multiple: number
  } | undefined
  if (!poll) return c.json({ error: 'not found' }, 404)
  if (poll.closes_at && poll.closes_at < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'poll is closed' }, 400)
  }

  const option = db.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(body.optionId, pollId)
  if (!option) return c.json({ error: 'invalid option' }, 400)

  if (!poll.allow_multiple) {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId)
  }

  try {
    db.prepare('INSERT INTO poll_votes (id, poll_id, option_id, user_id) VALUES (?, ?, ?, ?)').run(uuidv4(), pollId, body.optionId, userId)
  } catch {
    // Already voted for this option — unvote (toggle)
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND option_id = ? AND user_id = ?').run(pollId, body.optionId, userId)
  }

  const options = db.prepare(`
    SELECT po.id, po.label, po.position, COUNT(pv.id) as vote_count
    FROM poll_options po
    LEFT JOIN poll_votes pv ON pv.option_id = po.id
    WHERE po.poll_id = ?
    GROUP BY po.id ORDER BY po.position
  `).all(pollId) as { id: string; label: string; position: number; vote_count: number }[]

  const userVotes = db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').all(pollId, userId) as { option_id: string }[]

  const payload = { pollId, options, totalVotes: options.reduce((s, o) => s + o.vote_count, 0) }
  const io = getIo(c)

  if (io) {
    if (poll.channel_type === 'dm') {
      const dmChannel = db.prepare('SELECT user1_id, user2_id FROM dm_channels WHERE id = ?').get(poll.channel_id) as { user1_id: string; user2_id: string } | undefined
      if (dmChannel) {
        io.to(`dm:${dmChannel.user1_id}`).emit('poll:update', payload as never)
        io.to(`dm:${dmChannel.user2_id}`).emit('poll:update', payload as never)
      }
    } else if (poll.channel_type === 'group-dm') {
      const members = db.prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ?').all(poll.channel_id) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('poll:update', payload as never)
      }
    } else {
      io.to(poll.channel_id).emit('poll:update', payload as never)
    }
  }

  return c.json({ options, userVoteIds: userVotes.map(v => v.option_id) })
})

// Delete a poll (admin or creator only)
pollsRouter.delete('/polls/:pollId', authMiddleware, async (c) => {
  const db = getDb()
  const { pollId } = c.req.param()
  const { userId } = getAuth(c)

  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId) as {
    id: string; channel_id: string; channel_type: string; message_id: string; question: string
    created_by: string; created_at: number; closes_at: number | null; allow_multiple: number
  } | undefined
  if (!poll) return c.json({ error: 'not found' }, 404)

  if (poll.created_by !== userId && !isUserAdmin(userId)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(pollId)
  db.prepare('DELETE FROM poll_options WHERE poll_id = ?').run(pollId)
  db.prepare('DELETE FROM polls WHERE id = ?').run(pollId)

  const io = getIo(c)
  if (io) {
    const payload = { pollId, channelId: poll.channel_id, channelType: poll.channel_type }
    if (poll.channel_type === 'dm') {
      const dmChannel = db.prepare('SELECT user1_id, user2_id FROM dm_channels WHERE id = ?').get(poll.channel_id) as { user1_id: string; user2_id: string } | undefined
      if (dmChannel) {
        io.to(`dm:${dmChannel.user1_id}`).emit('poll:deleted', payload as never)
        io.to(`dm:${dmChannel.user2_id}`).emit('poll:deleted', payload as never)
      }
    } else if (poll.channel_type === 'group-dm') {
      const members = db.prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ?').all(poll.channel_id) as { user_id: string }[]
      for (const m of members) {
        io.to(`group-dm:${m.user_id}`).emit('poll:deleted', payload as never)
      }
    } else {
      io.to(poll.channel_id).emit('poll:deleted', payload as never)
    }
  }

  return c.json({ success: true })
})

export default pollsRouter
