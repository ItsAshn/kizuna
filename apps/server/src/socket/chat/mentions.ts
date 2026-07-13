import type { Server } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db'
import { getEligibleNotifyUserIds } from '../../middleware/auth'
import { type MentionResult, type ProcessMentionsMessage } from './infra'

export function parseMentions(content: string): MentionResult[] {
  const results: MentionResult[] = []
  const seen = new Set<string>()

  if (/@everyone\b/.test(content) && !seen.has('everyone')) {
    results.push({ type: 'everyone', target: null })
    seen.add('everyone')
  }
  if (/@here\b/.test(content) && !seen.has('here')) {
    results.push({ type: 'here', target: null })
    seen.add('here')
  }

  const userPattern = /@([\w.-]+)/g
  let match
  while ((match = userPattern.exec(content)) !== null) {
    const username = match[1]!.toLowerCase()
    if (username === 'everyone' || username === 'here') continue
    if (!seen.has(username)) {
      results.push({ type: 'user', target: username })
      seen.add(username)
    }
  }

  return results
}

export function processMentions(io: Server, message: ProcessMentionsMessage, mentions: MentionResult[]): void {
  if (!mentions.length) return
  const db = getDb()

  for (const mention of mentions) {
    const mentionId = uuidv4()
    const base = {
      id: mentionId,
      message_id: message.id,
      channel_id: message.channel_id,
      author_id: message.author_id || message.user_id,
      author_username: message.author_username || message.username,
      content: message.content,
      mention_type: mention.type,
    }

    if (mention.type === 'everyone' || mention.type === 'here') {
      db.prepare(
        `INSERT OR IGNORE INTO mentions
         (id, message_id, channel_id, author_id, author_username, content, mention_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(mentionId, message.id, message.channel_id, base.author_id, base.author_username, message.content, mention.type)

      for (const uid of getEligibleNotifyUserIds(message.channel_id, base.author_id!)) {
        io.to(`user:${uid}`).emit('message:mention', {
          ...base,
          mentionedUserId: null,
        })
      }
    } else {
      // Check if this matches a mentionable role first
      const role = db.prepare(
        "SELECT id, name FROM roles WHERE LOWER(name) = ? AND mentionable = 1"
      ).get(mention.target!.toLowerCase()) as { id: string; name: string } | undefined

      if (role) {
        const roleMembers = db.prepare(
          'SELECT user_id FROM member_roles WHERE role_id = ?'
        ).all(role.id) as { user_id: string }[]

        for (const rm of roleMembers) {
          const roleMentionId = uuidv4()
          db.prepare(
            `INSERT OR IGNORE INTO mentions
             (id, message_id, channel_id, author_id, author_username, mentioned_user_id, content, mention_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(roleMentionId, message.id, message.channel_id, base.author_id, base.author_username, rm.user_id, message.content, 'role')

          io.to(`user:${rm.user_id}`).emit('message:mention', {
            ...base,
            id: roleMentionId,
            mention_type: 'role',
            mentioned_user_id: rm.user_id,
            role_name: role.name,
            role_id: role.id,
          })
        }
        continue
      }

      const user = db.prepare('SELECT id, username FROM users WHERE username = ?').get(mention.target!) as { id: string; username: string } | undefined
      if (!user) continue

      db.prepare(
        `INSERT OR IGNORE INTO mentions
         (id, message_id, channel_id, author_id, author_username, mentioned_user_id, content, mention_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(mentionId, message.id, message.channel_id, base.author_id, base.author_username, user.id, message.content, 'user')

      io.to(`user:${user.id}`).emit('message:mention', {
        ...base,
        mentionedUserId: user.id,
      })
    }
  }
}
