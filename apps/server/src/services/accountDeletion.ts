import { getDb } from '../db'
import { deleteGroupDmRows, deleteMessagesWhere, unlinkAttachmentFiles } from './messageDeletion'

/**
 * Placeholder account that inherits references a deleted user leaves behind in
 * rows that must outlive them: audit log entries, bans they issued, invites,
 * pins, threads, GIFs, edit history and incoming webhooks. Those columns are
 * NOT NULL foreign keys, and SQLite can only relax that with a full table
 * rebuild, so the rows are re-pointed here instead of being deleted (which
 * would, for example, let a moderator erase their own audit trail or lift
 * every ban they issued by deleting their account).
 *
 * It is never a server member, its username fails usernameSchema so nobody can
 * register or log in as it, and its password hash is not a bcrypt hash.
 */
export const DELETED_USER_ID = 'deleted-user'

function ensureDeletedUser(): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO users (id, username, display_name, password_hash)
       VALUES (?, '[deleted]', 'Deleted User', '!')`,
    )
    .run(DELETED_USER_ID)
}

// Columns that keep their row and are re-pointed at DELETED_USER_ID.
const REASSIGNED: [table: string, column: string][] = [
  ['invite_codes', 'created_by'],
  ['gifs', 'uploaded_by'],
  ['audit_logs', 'actor_id'],
  ['message_edits', 'edited_by'],
  ['threads', 'creator_id'],
  ['pinned_messages', 'pinned_by'],
  ['bans', 'banned_by'],
  // ON DELETE CASCADE would silently remove an integration because the admin
  // who created it left; outgoing webhooks already use SET NULL for this.
  ['webhooks', 'created_by'],
]

/**
 * Deletes an account in one transaction, children before parents, so it either
 * fully succeeds or leaves nothing half-deleted.
 *
 * With `deleteData`, the user's channel messages, DMs and group-DM messages
 * (with their attachments, reactions, pins, mentions and edit history) and
 * their polls are removed as well. Without it those messages stay, attributed
 * by the username stored on each row.
 *
 * Attachment files are unlinked only after the transaction commits, so a
 * failed delete never leaves rows pointing at files that are already gone.
 */
export function deleteUserAccount(userId: string, deleteData: boolean): void {
  if (userId === DELETED_USER_ID) throw new Error('Cannot delete the placeholder account')
  const db = getDb()

  const attachmentUrls = db.transaction((): string[] => {
    const urls: string[] = []
    ensureDeletedUser()

    // ── Content ────────────────────────────────────────────────────────────
    if (deleteData) {
      const threadIds = (
        db
          .prepare(
            'SELECT DISTINCT thread_id FROM messages WHERE author_id = ? AND thread_id IS NOT NULL',
          )
          .all(userId) as { thread_id: string }[]
      ).map((r) => r.thread_id)

      urls.push(...deleteMessagesWhere('messages', 'author_id = ?', [userId]))

      // Keep thread reply counts honest after removing the user's replies.
      const recount = db.prepare(
        'UPDATE threads SET message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = threads.id) WHERE id = ?',
      )
      for (const id of threadIds) recount.run(id)

      urls.push(
        ...deleteMessagesWhere(
          'direct_messages',
          `from_id = ? OR to_id = ?
           OR channel_id IN (SELECT id FROM dm_channels WHERE user1_id = ? OR user2_id = ?)`,
          [userId, userId, userId, userId],
        ),
      )
      urls.push(...deleteMessagesWhere('group_dm_messages', 'from_id = ?', [userId]))
      db.prepare('DELETE FROM polls WHERE created_by = ?').run(userId)
    } else {
      // polls.created_by cascades; keep polls whose messages are being kept.
      db.prepare('UPDATE polls SET created_by = ? WHERE created_by = ?').run(
        DELETED_USER_ID,
        userId,
      )
    }

    // ── Direct messages ────────────────────────────────────────────────────
    db.prepare(
      'DELETE FROM dm_reads WHERE user_id = ? OR channel_id IN (SELECT id FROM dm_channels WHERE user1_id = ? OR user2_id = ?)',
    ).run(userId, userId, userId)
    db.prepare('DELETE FROM dm_channels WHERE user1_id = ? OR user2_id = ?').run(userId, userId)

    // ── Group DMs ──────────────────────────────────────────────────────────
    db.prepare('DELETE FROM group_dm_reads WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM group_dm_voice_participants WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM group_dm_members WHERE user_id = ?').run(userId)

    // owner_id is NOT NULL: hand each owned group to its longest-standing
    // remaining member, or delete the group if nobody is left.
    const owned = db.prepare('SELECT id FROM group_dm_channels WHERE owner_id = ?').all(userId) as {
      id: string
    }[]
    for (const { id } of owned) {
      const heir = db
        .prepare(
          'SELECT user_id FROM group_dm_members WHERE channel_id = ? ORDER BY joined_at ASC, rowid ASC LIMIT 1',
        )
        .get(id) as { user_id: string } | undefined
      if (heir) {
        db.prepare('UPDATE group_dm_channels SET owner_id = ? WHERE id = ?').run(heir.user_id, id)
      } else {
        urls.push(...deleteGroupDmRows(id))
      }
    }

    // ── References that outlive the user ───────────────────────────────────
    for (const [table, column] of REASSIGNED) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(
        DELETED_USER_ID,
        userId,
      )
    }

    // ── Per-user state ─────────────────────────────────────────────────────
    db.prepare('DELETE FROM mentions WHERE mentioned_user_id = ?').run(userId)
    db.prepare('DELETE FROM mention_reads WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM message_reactions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM poll_votes WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM channel_reads WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM channel_mutes WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM identity_links WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM verification_tokens WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM bans WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM removed_members WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM server_members WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)

    return urls
  })()

  unlinkAttachmentFiles(attachmentUrls)
}
