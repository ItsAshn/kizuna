import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The db module reads SERVER_DB_PATH when it first opens the database, so the
// environment is set up before anything that imports it is loaded.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-db-test-'))
process.env.SERVER_DB_PATH = path.join(tmpDir, 'server.db')
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads')
process.env.JWT_SECRET = 'test-secret-'.padEnd(64, 'x')
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true })

type DbModule = typeof import('./index')
let dbm: DbModule
let db: Database.Database

let seq = 0
const uid = (p: string) => `${p}-${++seq}`

function addUser(id = uid('user')): string {
  db.prepare(
    "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, 'x')",
  ).run(id, id, id)
  db.prepare("INSERT INTO server_members (user_id, role) VALUES (?, 'member')").run(id)
  return id
}

function addChannel(id = uid('chan')): string {
  db.prepare("INSERT INTO channels (id, name, type) VALUES (?, ?, 'text')").run(id, id)
  return id
}

function addMessage(
  channelId: string,
  authorId: string,
  content = 'hello world',
  createdAt = 1_700_000_000,
  threadId: string | null = null,
): string {
  const id = uid('msg')
  db.prepare(
    `INSERT INTO messages (id, channel_id, author_id, author_username, content, created_at, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channelId, authorId, authorId, content, createdAt, threadId)
  return id
}

function addAttachment(messageId: string): string {
  const name = `${uid('file')}.png`
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR!, name), 'x')
  db.prepare('INSERT INTO attachments (id, message_id, filename, url) VALUES (?, ?, ?, ?)').run(
    uid('att'),
    messageId,
    name,
    `/uploads/${name}`,
  )
  return path.join(process.env.UPLOADS_DIR!, name)
}

function fkViolations(): unknown[] {
  return db.pragma('foreign_key_check') as unknown[]
}

function reopen(): void {
  dbm.closeDb()
  db = dbm.initDb()
}

beforeAll(async () => {
  dbm = await import('./index')
  db = dbm.initDb()
})

afterAll(() => {
  dbm.closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('re-running initDb on an up-to-date database is a no-op', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n
    reopen()
    reopen()
    const after = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n
    expect(after).toBe(before)
    expect(fkViolations()).toEqual([])
  })

  it('replays every migration on a database with no users without failing', () => {
    db.prepare('DELETE FROM _migrations').run()
    expect(() => reopen()).not.toThrow()
    expect(fkViolations()).toEqual([])
  })

  it('converts the old single FTS table to the external-content layout', () => {
    const owner = addUser()
    const chan = addChannel()
    addMessage(chan, owner, 'legacy wombat')
    // Recreate the pre-migration state: old layout, conversion not yet applied.
    db.exec('DROP TABLE dm_messages_fts')
    db.prepare(
      "DELETE FROM _migrations WHERE name IN ('messages_fts_rebuild', 'group_dm_fts', 'fts_external_content')",
    ).run()
    expect(() => reopen()).not.toThrow()
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(triggers).not.toContain('messages_fts_insert')
    expect(triggers).toContain('messages_fts_ai')
    const hit = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH \'"wombat"\'')
      .all()
    expect(hit).toHaveLength(1)
  })

  it('replays every migration over an already-migrated schema without failing', () => {
    const owner = addUser()
    const chan = addChannel()
    addMessage(chan, owner, 'replayed migration survivor')
    db.prepare('DELETE FROM _migrations').run()
    expect(() => reopen()).not.toThrow()
    expect(fkViolations()).toEqual([])
    // FTS is rebuilt from the message table, so existing messages stay searchable.
    const hit = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH \'"survivor"\'')
      .all()
    expect(hit).toHaveLength(1)
  })

  it('replays when only the newest migrations are missing', () => {
    db.prepare(
      "DELETE FROM _migrations WHERE name IN ('fts_external_content', 'idx_message_and_poll_lookups', 'verification_tokens_nonce', 'mention_reads_table')",
    ).run()
    expect(() => reopen()).not.toThrow()
  })

  it('polls_remove_channel_fk is idempotent, keeps poll options, and clears a leftover polls_new', () => {
    const user = addUser()
    const pollId = uid('poll')
    db.prepare(
      "INSERT INTO polls (id, channel_id, channel_type, message_id, question, created_by) VALUES (?, 'general', 'channel', ?, 'q?', ?)",
    ).run(pollId, pollId, user)
    db.prepare("INSERT INTO poll_options (id, poll_id, label) VALUES (?, ?, 'a')").run(
      uid('opt'),
      pollId,
    )
    // Simulate an interrupted earlier run that left polls_new (with a clashing row).
    db.exec('CREATE TABLE polls_new AS SELECT * FROM polls')
    db.prepare("DELETE FROM _migrations WHERE name = 'polls_remove_channel_fk'").run()

    expect(() => reopen()).not.toThrow()
    const leftover = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'polls_new'")
      .get()
    expect(leftover).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM polls WHERE id = ?').get(pollId)).toBeTruthy()
    // Rebuilding polls with foreign keys on would have cascaded into options.
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM poll_options WHERE poll_id = ?').get(pollId) as {
          n: number
        }
      ).n,
    ).toBe(1)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('creates the lookup indexes', () => {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name)
    for (const idx of [
      'idx_mentions_message',
      'idx_pinned_messages_message',
      'idx_poll_options_poll',
      'idx_poll_votes_option',
    ]) {
      expect(names).toContain(idx)
    }
  })
})

describe('full-text search index', () => {
  const match = (table: string, term: string) =>
    (db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(`"${term}"`) as unknown[])
      .length

  it('follows inserts, edits and deletes on channel messages', () => {
    const user = addUser()
    const chan = addChannel()
    const id = addMessage(chan, user, 'zebracorn sighting')
    expect(match('messages_fts', 'zebracorn')).toBe(1)

    db.prepare("UPDATE messages SET content = 'unicornzebra only' WHERE id = ?").run(id)
    expect(match('messages_fts', 'zebracorn')).toBe(0)
    expect(match('messages_fts', 'unicornzebra')).toBe(1)

    db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    expect(match('messages_fts', 'unicornzebra')).toBe(0)
    expect(
      db
        .prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)")
        .run(),
    ).toBeTruthy()
  })

  it('indexes DMs and group DMs in their own tables', () => {
    const a = addUser()
    const b = addUser()
    db.prepare('INSERT INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(
      'dmc-fts',
      a,
      b,
    )
    db.prepare(
      "INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content) VALUES ('dm-fts', 'dmc-fts', ?, ?, ?, 'pangolin secret')",
    ).run(a, a, b)
    db.prepare("INSERT INTO group_dm_channels (id, name, owner_id) VALUES ('g-fts', 'g', ?)").run(a)
    db.prepare(
      "INSERT INTO group_dm_messages (id, channel_id, from_id, from_username, content) VALUES ('gm-fts', 'g-fts', ?, ?, 'axolotl party')",
    ).run(a, a)
    expect(match('dm_messages_fts', 'pangolin')).toBe(1)
    expect(match('group_dm_messages_fts', 'axolotl')).toBe(1)
    db.prepare("DELETE FROM direct_messages WHERE id = 'dm-fts'").run()
    db.prepare("DELETE FROM group_dm_messages WHERE id = 'gm-fts'").run()
    expect(match('dm_messages_fts', 'pangolin')).toBe(0)
    expect(match('group_dm_messages_fts', 'axolotl')).toBe(0)
  })
})

describe('HTTP queries', () => {
  async function authHeader(userId: string) {
    const { signToken } = await import('../middleware/auth')
    return { Authorization: `Bearer ${signToken({ userId, username: userId })}` }
  }

  it('message pagination does not skip messages that share a second with the anchor', async () => {
    const { default: messageRoutes } = await import('../routes/messages')
    const user = addUser()
    const chan = addChannel()
    const ids: string[] = []
    // Seven messages, all in the same second.
    for (let i = 0; i < 7; i++) ids.push(addMessage(chan, user, `same second ${i}`, 1_700_000_500))

    const headers = await authHeader(user)
    const seen: string[] = []
    let before: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const qs = new URLSearchParams({ limit: '3', ...(before ? { before } : {}) })
      const res = await messageRoutes.request(`/${chan}?${qs}`, { headers })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { messages: { id: string }[]; hasMore: boolean }
      seen.unshift(...body.messages.map((m) => m.id))
      if (!body.hasMore || body.messages.length === 0) break
      before = body.messages[0]!.id
    }
    expect(seen).toEqual(ids)
  })

  it('search reports hasMore and pages through every match', async () => {
    const { default: searchRoutes } = await import('../routes/search')
    const user = addUser()
    const chan = addChannel()
    const ids: string[] = []
    for (let i = 0; i < 5; i++)
      ids.push(addMessage(chan, user, `quokka number ${i}`, 1_700_001_000))

    const headers = await authHeader(user)
    const first = (await (
      await searchRoutes.request('/?query=quokka&limit=3', { headers })
    ).json()) as { results: { message: { id: string } }[]; hasMore: boolean }
    expect(first.results).toHaveLength(3)
    expect(first.hasMore).toBe(true)

    const last = first.results[2]!.message.id
    const second = (await (
      await searchRoutes.request(`/?query=quokka&limit=3&before=${last}`, { headers })
    ).json()) as { results: { message: { id: string } }[]; hasMore: boolean }
    expect(second.results).toHaveLength(2)
    expect(second.hasMore).toBe(false)

    const all = [...first.results, ...second.results].map((r) => r.message.id)
    expect(new Set(all)).toEqual(new Set(ids))
  })

  it('search hides channels the user cannot view', async () => {
    const { default: searchRoutes } = await import('../routes/search')
    const user = addUser()
    const roleId = uid('role')
    db.prepare("INSERT INTO roles (id, name) VALUES (?, 'muzzled')").run(roleId)
    db.prepare('INSERT INTO member_roles (user_id, role_id) VALUES (?, ?)').run(user, roleId)
    const hidden = addChannel()
    db.prepare('UPDATE channels SET hidden = 1, hidden_role_ids = ? WHERE id = ?').run(
      JSON.stringify([roleId]),
      hidden,
    )
    addMessage(hidden, user, 'narwhal hidden')
    const visible = addChannel()
    addMessage(visible, user, 'narwhal visible')

    const res = (await (
      await searchRoutes.request('/?query=narwhal', { headers: await authHeader(user) })
    ).json()) as { results: { message: { channel_id: string } }[] }
    expect(res.results.map((r) => r.message.channel_id)).toEqual([visible])
  })
})

describe('getEligibleNotifyUserIds', () => {
  it('matches canViewChannel for every member', async () => {
    const { getEligibleNotifyUserIds, canViewChannel, clearPermissionCache } =
      await import('../middleware/auth')
    clearPermissionCache()
    const roleHidden = uid('role')
    const roleOther = uid('role')
    db.prepare("INSERT INTO roles (id, name) VALUES (?, 'h'), (?, 'o')").run(roleHidden, roleOther)
    const chan = addChannel()
    db.prepare('UPDATE channels SET hidden = 1, hidden_role_ids = ? WHERE id = ?').run(
      JSON.stringify([roleHidden]),
      chan,
    )
    const actor = addUser()
    const viaMemberRole = addUser()
    db.prepare('INSERT INTO member_roles (user_id, role_id) VALUES (?, ?)').run(
      viaMemberRole,
      roleHidden,
    )
    const viaCustomRole = addUser()
    db.prepare('UPDATE server_members SET custom_role_id = ? WHERE user_id = ?').run(
      roleHidden,
      viaCustomRole,
    )
    const hiddenButAdmin = addUser()
    db.prepare('INSERT INTO member_roles (user_id, role_id) VALUES (?, ?), (?, ?)').run(
      hiddenButAdmin,
      roleHidden,
      hiddenButAdmin,
      'admin-role',
    )
    const other = addUser()
    db.prepare('INSERT INTO member_roles (user_id, role_id) VALUES (?, ?)').run(other, roleOther)
    const muted = addUser()
    db.prepare('INSERT INTO channel_mutes (user_id, channel_id) VALUES (?, ?)').run(muted, chan)

    const eligible = new Set(getEligibleNotifyUserIds(chan, actor))
    expect(eligible.has(actor)).toBe(false)
    expect(eligible.has(viaMemberRole)).toBe(false)
    expect(eligible.has(viaCustomRole)).toBe(false)
    expect(eligible.has(hiddenButAdmin)).toBe(true)
    expect(eligible.has(other)).toBe(true)
    expect(eligible.has(muted)).toBe(false)

    const members = (
      db.prepare('SELECT user_id FROM server_members WHERE user_id != ?').all(actor) as {
        user_id: string
      }[]
    ).map((r) => r.user_id)
    const mutedSet = new Set([muted])
    const expected = members.filter((u) => !mutedSet.has(u) && canViewChannel(u, chan))
    expect([...eligible].sort()).toEqual(expected.sort())
  })
})

describe('channel deletion', () => {
  it('removes a channel with pins, threads, edits, mentions, polls and attachments', async () => {
    const { deleteChannelRows, unlinkAttachmentFiles } = await import('../services/messageDeletion')
    const user = addUser()
    const other = addUser()
    const chan = addChannel()
    const root = addMessage(chan, user, 'root')
    const file = addAttachment(root)
    const threadId = uid('thread')
    db.prepare('INSERT INTO threads (id, channel_id, name, creator_id) VALUES (?, ?, ?, ?)').run(
      threadId,
      chan,
      't',
      user,
    )
    const reply = addMessage(chan, other, 'reply', 1_700_000_001, threadId)
    db.prepare(
      'INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)',
    ).run(uid('pin'), chan, root, other)
    db.prepare(
      "INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, 'old', ?, 1)",
    ).run(uid('edit'), reply, other)
    const mentionId = uid('mention')
    db.prepare(
      "INSERT INTO mentions (id, message_id, channel_id, author_id, author_username, mention_type, content) VALUES (?, ?, ?, ?, ?, 'everyone', 'x')",
    ).run(mentionId, root, chan, user, user)
    db.prepare('INSERT INTO mention_reads (mention_id, user_id) VALUES (?, ?)').run(
      mentionId,
      other,
    )
    db.prepare(
      "INSERT INTO message_reactions (message_id, user_id, reaction_key) VALUES (?, ?, 'x')",
    ).run(root, other)
    db.prepare(
      'INSERT INTO channel_reads (user_id, channel_id, last_read_at) VALUES (?, ?, 1)',
    ).run(other, chan)
    db.prepare('INSERT INTO channel_mutes (user_id, channel_id) VALUES (?, ?)').run(other, chan)
    db.prepare(
      "INSERT INTO channel_role_overrides (channel_id, role_id) VALUES (?, 'admin-role')",
    ).run(chan)
    const pollId = uid('poll')
    db.prepare(
      "INSERT INTO polls (id, channel_id, channel_type, message_id, question, created_by) VALUES (?, ?, 'channel', ?, 'q', ?)",
    ).run(pollId, chan, pollId, user)
    db.prepare("INSERT INTO poll_options (id, poll_id, label) VALUES (?, ?, 'a')").run(
      uid('opt'),
      pollId,
    )
    db.prepare(
      "INSERT INTO webhooks (id, channel_id, name, token, created_by) VALUES (?, ?, 'hook', ?, ?)",
    ).run(uid('hook'), chan, uid('tok'), user)

    unlinkAttachmentFiles(deleteChannelRows(chan))

    expect(db.prepare('SELECT 1 FROM channels WHERE id = ?').get(chan)).toBeUndefined()
    for (const table of [
      'messages',
      'pinned_messages',
      'threads',
      'mentions',
      'channel_reads',
      'channel_mutes',
      'channel_role_overrides',
      'polls',
      'webhooks',
    ]) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE channel_id = ?`).get(chan) as {
          n: number
        }
      ).n
      expect(n, table).toBe(0)
    }
    expect(db.prepare('SELECT 1 FROM attachments WHERE message_id = ?').get(root)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM poll_options WHERE poll_id = ?').get(pollId)).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
    expect(fkViolations()).toEqual([])
  })
})

describe('account deletion', () => {
  async function seedUserWithEverything() {
    const user = addUser()
    const friend = addUser()
    const friend2 = addUser()
    const chan = addChannel()

    const own = addMessage(chan, user, 'my message')
    const file = addAttachment(own)
    const friendMsg = addMessage(chan, friend, `hey @${user}`)
    db.prepare(
      "INSERT INTO mentions (id, message_id, channel_id, author_id, author_username, mentioned_user_id, content) VALUES (?, ?, ?, ?, ?, ?, 'x')",
    ).run(uid('mention'), friendMsg, chan, friend, friend, user)
    db.prepare(
      "INSERT INTO mentions (id, message_id, channel_id, author_id, author_username, mentioned_user_id, content) VALUES (?, ?, ?, ?, ?, ?, 'x')",
    ).run(uid('mention'), own, chan, user, user, friend)
    // A pin the user made on someone else's message and one on their own.
    db.prepare(
      'INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)',
    ).run(uid('pin'), chan, friendMsg, user)
    db.prepare(
      'INSERT INTO pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)',
    ).run(uid('pin'), chan, own, friend)
    db.prepare(
      "INSERT INTO message_edits (id, message_id, old_content, edited_by, edited_at) VALUES (?, ?, 'old', ?, 1)",
    ).run(uid('edit'), own, user)
    db.prepare(
      "INSERT INTO message_reactions (message_id, user_id, reaction_key) VALUES (?, ?, 'x')",
    ).run(friendMsg, user)

    const threadId = uid('thread')
    db.prepare('INSERT INTO threads (id, channel_id, name, creator_id) VALUES (?, ?, ?, ?)').run(
      threadId,
      chan,
      't',
      user,
    )
    addMessage(chan, friend, 'thread reply', 1_700_000_002, threadId)

    // A group DM the user owns with others in it, and one only they are in.
    const sharedGroup = uid('gdm')
    db.prepare('INSERT INTO group_dm_channels (id, name, owner_id) VALUES (?, ?, ?)').run(
      sharedGroup,
      'shared',
      user,
    )
    db.prepare(
      'INSERT INTO group_dm_members (channel_id, user_id, joined_at) VALUES (?, ?, 1), (?, ?, 2), (?, ?, 3)',
    ).run(sharedGroup, user, sharedGroup, friend, sharedGroup, friend2)
    db.prepare(
      "INSERT INTO group_dm_messages (id, channel_id, from_id, from_username, content) VALUES (?, ?, ?, ?, 'gm')",
    ).run(uid('gm'), sharedGroup, user, user)
    const soloGroup = uid('gdm')
    db.prepare('INSERT INTO group_dm_channels (id, name, owner_id) VALUES (?, ?, ?)').run(
      soloGroup,
      'solo',
      user,
    )
    db.prepare('INSERT INTO group_dm_members (channel_id, user_id) VALUES (?, ?)').run(
      soloGroup,
      user,
    )
    db.prepare(
      "INSERT INTO group_dm_messages (id, channel_id, from_id, from_username, content) VALUES (?, ?, ?, ?, 'alone')",
    ).run(uid('gm'), soloGroup, user, user)

    const dmChan = uid('dmc')
    db.prepare('INSERT INTO dm_channels (id, user1_id, user2_id) VALUES (?, ?, ?)').run(
      dmChan,
      user,
      friend,
    )
    db.prepare(
      "INSERT INTO direct_messages (id, channel_id, from_id, from_username, to_id, content) VALUES (?, ?, ?, ?, ?, 'dm')",
    ).run(uid('dm'), dmChan, user, user, friend)
    db.prepare('INSERT INTO dm_reads (user_id, channel_id, last_read_at) VALUES (?, ?, 1)').run(
      friend,
      dmChan,
    )

    const invite = uid('invite')
    db.prepare('INSERT INTO invite_codes (code, created_by) VALUES (?, ?)').run(invite, user)
    db.prepare(
      "INSERT INTO gifs (id, display_name, stored_filename, original_filename, file_size, uploaded_by) VALUES (?, 'g', 'g.gif', 'g.gif', 1, ?)",
    ).run(uid('gif'), user)
    const auditId = uid('audit')
    db.prepare(
      "INSERT INTO audit_logs (id, action, actor_id, target_id) VALUES (?, 'ban', ?, ?)",
    ).run(auditId, user, friend2)
    const banId = uid('ban')
    db.prepare('INSERT INTO bans (id, user_id, banned_by) VALUES (?, ?, ?)').run(
      banId,
      friend2,
      user,
    )
    const pollId = uid('poll')
    db.prepare(
      "INSERT INTO polls (id, channel_id, channel_type, message_id, question, created_by) VALUES (?, ?, 'channel', ?, 'q', ?)",
    ).run(pollId, chan, pollId, user)
    db.prepare(
      "INSERT INTO webhooks (id, channel_id, name, token, created_by) VALUES (?, ?, 'hook', ?, ?)",
    ).run(uid('hook'), chan, uid('tok'), user)
    db.prepare('INSERT INTO sessions (token_id, user_id) VALUES (?, ?)').run(uid('sess'), user)
    db.prepare("INSERT INTO member_roles (user_id, role_id) VALUES (?, 'admin-role')").run(user)
    db.prepare(
      'INSERT INTO channel_reads (user_id, channel_id, last_read_at) VALUES (?, ?, 1)',
    ).run(user, chan)

    return {
      user,
      friend,
      chan,
      own,
      file,
      sharedGroup,
      soloGroup,
      invite,
      auditId,
      banId,
      pollId,
      threadId,
    }
  }

  it('deletes an account and its data without breaking any foreign key', async () => {
    const { deleteUserAccount, DELETED_USER_ID } = await import('../services/accountDeletion')
    const s = await seedUserWithEverything()

    expect(() => deleteUserAccount(s.user, true)).not.toThrow()

    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(s.user)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM messages WHERE author_id = ?').get(s.user)).toBeUndefined()
    expect(fs.existsSync(s.file)).toBe(false)
    expect(
      db.prepare('SELECT 1 FROM direct_messages WHERE from_id = ?').get(s.user),
    ).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM polls WHERE id = ?').get(s.pollId)).toBeUndefined()

    // Ownership passes to the longest-standing remaining member…
    const shared = db
      .prepare('SELECT owner_id FROM group_dm_channels WHERE id = ?')
      .get(s.sharedGroup) as { owner_id: string }
    expect(shared.owner_id).toBe(s.friend)
    // …and a group nobody is left in is removed.
    expect(
      db.prepare('SELECT 1 FROM group_dm_channels WHERE id = ?').get(s.soloGroup),
    ).toBeUndefined()

    // Records that must outlive the account are kept, attributed to the placeholder.
    const audit = db.prepare('SELECT actor_id FROM audit_logs WHERE id = ?').get(s.auditId) as {
      actor_id: string
    }
    expect(audit.actor_id).toBe(DELETED_USER_ID)
    const ban = db.prepare('SELECT banned_by FROM bans WHERE id = ?').get(s.banId) as {
      banned_by: string
    }
    expect(ban.banned_by).toBe(DELETED_USER_ID)
    const invite = db
      .prepare('SELECT created_by FROM invite_codes WHERE code = ?')
      .get(s.invite) as {
      created_by: string
    }
    expect(invite.created_by).toBe(DELETED_USER_ID)
    const thread = db.prepare('SELECT creator_id FROM threads WHERE id = ?').get(s.threadId) as {
      creator_id: string
    }
    expect(thread.creator_id).toBe(DELETED_USER_ID)
    // The placeholder never becomes a member.
    expect(
      db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(DELETED_USER_ID),
    ).toBeUndefined()

    expect(fkViolations()).toEqual([])
  })

  it('deletes an account but keeps its messages when data is not requested', async () => {
    const { deleteUserAccount } = await import('../services/accountDeletion')
    const s = await seedUserWithEverything()

    expect(() => deleteUserAccount(s.user, false)).not.toThrow()

    expect(db.prepare('SELECT 1 FROM users WHERE id = ?').get(s.user)).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(s.own)).toBeTruthy()
    expect(db.prepare('SELECT 1 FROM polls WHERE id = ?').get(s.pollId)).toBeTruthy()
    expect(fs.existsSync(s.file)).toBe(true)
    expect(fkViolations()).toEqual([])
  })

  it('deletes a second account after the placeholder already exists', async () => {
    const { deleteUserAccount } = await import('../services/accountDeletion')
    const s = await seedUserWithEverything()
    expect(() => deleteUserAccount(s.user, true)).not.toThrow()
    expect(fkViolations()).toEqual([])
  })
})
