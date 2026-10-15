import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db'

// Tables keyed by message_id that must be cleared before the message row itself.
// mentions, message_edits and pinned_messages hold non-cascading FKs to
// messages(id), so leaving any of them behind aborts the whole delete.
// message_reactions is cleared explicitly too: schema.ts and the
// message_reactions_v1 migration disagree on whether it has an ON DELETE CASCADE
// FK, so whichever one created the table decides — we can't rely on the cascade.
// DM and group-DM message ids live in the same id space (attachments and
// reactions can belong to those too), so this list serves all three tables.
const DEPENDENT_TABLES = [
  'attachments',
  'mentions',
  'message_edits',
  'pinned_messages',
  'message_reactions',
] as const

export type MessageTable = 'messages' | 'direct_messages' | 'group_dm_messages'

/**
 * Deletes every row of `table` matching `where` (a trusted SQL fragment over
 * that table, with `?` placeholders bound from `params`) together with every
 * row that references those messages, in one transaction. Returns the URLs of
 * the attachments that were removed so the caller can unlink the files once
 * the transaction has committed (see unlinkAttachmentFiles).
 */
export function deleteMessagesWhere(
  table: MessageTable,
  where: string,
  params: unknown[] = [],
): string[] {
  const db = getDb()
  const ids = `SELECT id FROM ${table} WHERE ${where}`

  return db.transaction(() => {
    const attachments = db
      .prepare(`SELECT url FROM attachments WHERE message_id IN (${ids})`)
      .all(...params) as { url: string }[]

    for (const dep of DEPENDENT_TABLES) {
      db.prepare(`DELETE FROM ${dep} WHERE message_id IN (${ids})`).run(...params)
    }
    db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params)

    return attachments.map((att) => att.url)
  })()
}

/**
 * Removes a message and every row that references it, in one transaction.
 * Returns the URLs of the attachments that were detached so the caller can
 * unlink the files on disk.
 */
export function deleteMessageRows(messageId: string): string[] {
  return deleteMessagesWhere('messages', 'id = ?', [messageId])
}

export function uploadsDir(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
}

/** Best-effort removal of attachment files; a missing file is not an error. */
export function unlinkAttachmentFiles(urls: string[]): void {
  const dir = uploadsDir()
  for (const url of urls) {
    try {
      fs.unlinkSync(path.join(dir, path.basename(url)))
    } catch {
      /* file may not exist */
    }
  }
}

/**
 * Deletes a channel and everything that hangs off it, children before parents
 * so no FK is violated mid-way, in one transaction. Thread replies share the
 * parent's channel_id, so they go with the channel's messages. webhooks and
 * outgoing_webhooks cascade from channels; mention_reads cascades from
 * mentions; poll options and votes cascade from polls. Returns attachment URLs
 * to unlink after the commit.
 */
export function deleteChannelRows(channelId: string): string[] {
  const db = getDb()
  return db.transaction(() => {
    const urls = deleteMessagesWhere('messages', 'channel_id = ?', [channelId])
    // Rows that point at the channel but not (or no longer) at a message.
    db.prepare('DELETE FROM mentions WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM pinned_messages WHERE channel_id = ?').run(channelId)
    db.prepare("DELETE FROM polls WHERE channel_id = ? AND channel_type = 'channel'").run(channelId)
    db.prepare('DELETE FROM threads WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM channel_mutes WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM channel_reads WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM channel_role_overrides WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId)
    return urls
  })()
}

/**
 * Deletes a group DM with its messages, members, reads and call history, in
 * one transaction. Returns attachment URLs to unlink after the commit.
 */
export function deleteGroupDmRows(channelId: string): string[] {
  const db = getDb()
  return db.transaction(() => {
    const urls = deleteMessagesWhere('group_dm_messages', 'channel_id = ?', [channelId])
    db.prepare('DELETE FROM group_dm_reads WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM group_dm_voice_participants WHERE channel_id = ?').run(channelId)
    db.prepare("DELETE FROM polls WHERE channel_id = ? AND channel_type = 'group-dm'").run(
      channelId,
    )
    db.prepare('DELETE FROM group_dm_members WHERE channel_id = ?').run(channelId)
    db.prepare('DELETE FROM group_dm_channels WHERE id = ?').run(channelId)
    return urls
  })()
}
