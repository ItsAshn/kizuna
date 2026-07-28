import { getDb } from '../db'

// Tables keyed by message_id that must be cleared before the message row itself.
// mentions, message_edits and pinned_messages hold non-cascading FKs to
// messages(id), so leaving any of them behind aborts the whole delete.
// message_reactions is cleared explicitly too: schema.ts and the
// message_reactions_v1 migration disagree on whether it has an ON DELETE CASCADE
// FK, so whichever one created the table decides — we can't rely on the cascade.
const DEPENDENT_TABLES = [
  'attachments',
  'mentions',
  'message_edits',
  'pinned_messages',
  'message_reactions',
] as const

/**
 * Removes a message and every row that references it, in one transaction.
 * Returns the URLs of the attachments that were detached so the caller can
 * unlink the files on disk.
 */
export function deleteMessageRows(messageId: string): string[] {
  const db = getDb()

  return db.transaction(() => {
    const attachments = db
      .prepare('SELECT url FROM attachments WHERE message_id = ?')
      .all(messageId) as { url: string }[]

    for (const table of DEPENDENT_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE message_id = ?`).run(messageId)
    }
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)

    return attachments.map((att) => att.url)
  })()
}
