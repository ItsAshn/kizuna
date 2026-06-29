import { Hono } from 'hono'
import type { Context } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { v4 as uuidv4 } from 'uuid'
import type { AuthUser } from '../types'
import type { Server as IoServer } from 'socket.io'

function getAuth(c: Context): AuthUser { return c.get('auth') }

const pollsRouter = new Hono()
pollsRouter.use('*', authMiddleware)

// Create a poll in a channel
pollsRouter.post('/channels/:channelId/polls', async (c) => {
  const db = getDb()
  const { channelId } = c.req.param()
  const { userId, username } = getAuth(c)
  const body = await c.req.json().catch(() => null)
  if (!body || !body.question?.trim() || !Array.isArray(body.options) || body.options.length < 2) {
    return c.json({ error: 'question and at least 2 options required' }, 400)
  }

  const question = body.question.trim().slice(0, 300)
  const options: string[] = body.options.map((o: string) => String(o).trim()).filter(Boolean).slice(0, 10)
  if (options.length < 2) return c.json({ error: 'need at least 2 non-empty options' }, 400)

  const pollId = uuidv4()
  const messageId = uuidv4()
  const now = Math.floor(Date.now() / 1000)

  const author = db.prepare('SELECT display_name, avatar FROM users WHERE id = ?').get(userId) as { display_name: string; avatar: string | null } | undefined

  db.prepare(`INSERT INTO polls (id, channel_id, message_id, question, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(pollId, channelId, messageId, question, userId, now)

  options.forEach((label, i) => {
    db.prepare(`INSERT INTO poll_options (id, poll_id, label, position) VALUES (?, ?, ?, ?)`).run(uuidv4(), pollId, label, i)
  })

  const content = JSON.stringify({ __poll__: true, pollId, question, options: options.map((label, i) => ({ id: '', label, position: i })) })
  db.prepare(`INSERT INTO messages (id, channel_id, user_id, content, author_username, author_display_name, author_avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    messageId, channelId, userId, content, username, author?.display_name ?? username, author?.avatar ?? null, now
  )

  // Fetch full poll options with ids for the broadcast
  const dbOptions = db.prepare('SELECT id, label, position FROM poll_options WHERE poll_id = ? ORDER BY position').all(pollId) as { id: string; label: string; position: number }[]
  const fullContent = JSON.stringify({ __poll__: true, pollId, question, options: dbOptions })
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(fullContent, messageId)

  const messageRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as {
    id: string
    channel_id: string
    user_id: string
    content: string
    author_username: string
    author_display_name: string
    author_avatar: string | null
    created_at: number
  }
  const message = {
    id: messageRow.id,
    channel_id: messageRow.channel_id,
    user_id: messageRow.user_id,
    content: messageRow.content,
    author_username: messageRow.author_username,
    author_display_name: messageRow.author_display_name,
    author_avatar: messageRow.author_avatar,
    created_at: messageRow.created_at * 1000,
    edited_at: null,
    reply_to_id: null,
    reply_to_content: null,
    reply_to_username: null,
    reactions: [],
    attachments: [],
  }

  const io = c.get('io' as never) as IoServer | undefined
  io?.to(channelId).emit('message:new', message as never)

  return c.json({ poll: { id: pollId, question, options: dbOptions }, message })
})

// Get poll with vote counts
pollsRouter.get('/polls/:pollId', async (c) => {
  const db = getDb()
  const { pollId } = c.req.param()
  const { userId } = getAuth(c)

  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId) as {
    id: string; channel_id: string; message_id: string; question: string
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
pollsRouter.post('/polls/:pollId/vote', async (c) => {
  const db = getDb()
  const { pollId } = c.req.param()
  const { userId } = getAuth(c)
  const body = await c.req.json().catch(() => null)
  if (!body?.optionId) return c.json({ error: 'optionId required' }, 400)

  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId) as {
    id: string; channel_id: string; message_id: string; question: string
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

  const io = c.get('io' as never) as IoServer | undefined
  io?.to(poll.channel_id).emit('poll:update', { pollId, options, totalVotes: options.reduce((s, o) => s + o.vote_count, 0) } as never)

  return c.json({ options, userVoteIds: userVotes.map(v => v.option_id) })
})

export default pollsRouter
