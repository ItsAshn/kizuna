import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { SCHEMA_SQL, SEED_SQL } from './schema'

let db: Database.Database | null = null

export function getDbPath(): string {
  return process.env.SERVER_DB_PATH || path.join(process.cwd(), 'server.db')
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDbPath()
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

export function initDb(): Database.Database {
  const database = getDb()
  database.exec(SCHEMA_SQL)
  database.exec(SEED_SQL)
  runMigrations(database)
  return database
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

function runMigrations(database: Database.Database): void {
  const applied = new Set(
    (database.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(r => r.name),
  )

  interface Migration {
    name: string
    sql: string
  }

  const migrations: Migration[] = [
    { name: 'server_settings_table', sql: `CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )` },
    { name: 'invite_codes_table', sql: `CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER DEFAULT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )` },
    { name: 'roles_initial', sql: `CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#5865f2',
      permissions TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch())
    )` },
    { name: 'dm_channels_table', sql: `CREATE TABLE IF NOT EXISTS dm_channels (
      id TEXT PRIMARY KEY,
      user1_id TEXT NOT NULL,
      user2_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user1_id) REFERENCES users(id),
      FOREIGN KEY (user2_id) REFERENCES users(id)
    )` },
    { name: 'idx_dm_channels_users', sql: `CREATE INDEX IF NOT EXISTS idx_dm_channels_users ON dm_channels(user1_id, user2_id)` },
    { name: 'channel_reads_table', sql: `CREATE TABLE IF NOT EXISTS channel_reads (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )` },
    { name: 'dm_reads_table', sql: `CREATE TABLE IF NOT EXISTS dm_reads (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES dm_channels(id)
    )` },
    { name: 'message_edits_table', sql: `CREATE TABLE IF NOT EXISTS message_edits (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      old_content TEXT NOT NULL,
      edited_by TEXT NOT NULL,
      edited_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (edited_by) REFERENCES users(id)
    )` },
    { name: 'idx_messages_channel_created', sql: `CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at)` },
    { name: 'idx_mentions_user_read', sql: `CREATE INDEX IF NOT EXISTS idx_mentions_user_read ON mentions(mentioned_user_id, read)` },
    { name: 'idx_direct_messages_channel', sql: `CREATE INDEX IF NOT EXISTS idx_direct_messages_channel ON direct_messages(channel_id)` },
    { name: 'idx_message_edits_message', sql: `CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id)` },
    { name: 'users_add_public_key', sql: `ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT NULL` },
    { name: 'users_add_key_salt', sql: `ALTER TABLE users ADD COLUMN key_salt TEXT DEFAULT NULL` },
    { name: 'dm_add_encrypted', sql: `ALTER TABLE direct_messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0` },
    { name: 'dm_add_edited_at', sql: `ALTER TABLE direct_messages ADD COLUMN edited_at INTEGER DEFAULT NULL` },
    { name: 'users_add_reset_token', sql: `ALTER TABLE users ADD COLUMN reset_token TEXT DEFAULT NULL` },
    { name: 'users_add_reset_token_expires', sql: `ALTER TABLE users ADD COLUMN reset_token_expires_at INTEGER DEFAULT NULL` },
    { name: 'users_add_token_invalidated_at', sql: `ALTER TABLE users ADD COLUMN token_invalidated_at INTEGER DEFAULT NULL` },
    { name: 'member_roles_table', sql: `CREATE TABLE IF NOT EXISTS member_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    )` },
    { name: 'channels_add_locked', sql: `ALTER TABLE channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0` },
    { name: 'channels_add_write_role_id', sql: `ALTER TABLE channels ADD COLUMN write_role_id TEXT DEFAULT NULL` },
    { name: 'migrate_custom_role_to_member_roles', sql: `INSERT OR IGNORE INTO member_roles (user_id, role_id)
     SELECT user_id, custom_role_id FROM server_members WHERE custom_role_id IS NOT NULL` },
    { name: 'roles_add_is_admin', sql: `ALTER TABLE roles ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0` },
    { name: 'seed_admin_role', sql: `INSERT OR IGNORE INTO roles (id, name, color, permissions, is_admin) VALUES
     ('admin-role', 'Admin', '#f59e0b',
      '{"send_messages":true,"send_dm_messages":true,"add_reactions":true,"upload_attachments":true,"delete_messages":true,"manage_channels":true,"manage_roles":true,"kick_members":true,"manage_invites":true,"use_voice":true,"initiate_dm_calls":true}',
      1)` },
    { name: 'assign_admin_role', sql: `INSERT OR IGNORE INTO member_roles (user_id, role_id)
     SELECT user_id, 'admin-role' FROM server_members WHERE role = 'admin'
       AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = server_members.user_id AND mr.role_id = 'admin-role')` },
    { name: 'users_add_reset_requested_at', sql: `ALTER TABLE users ADD COLUMN reset_requested_at INTEGER DEFAULT NULL` },
    { name: 'users_add_backuptoken_hash', sql: `ALTER TABLE users ADD COLUMN backuptoken_hash TEXT DEFAULT NULL` },
    { name: 'server_members_add_is_host', sql: `ALTER TABLE server_members ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0` },
    { name: 'seed_first_host', sql: `UPDATE server_members SET is_host = 1 WHERE user_id = (
       SELECT user_id FROM server_members ORDER BY joined_at ASC LIMIT 1
     ) AND NOT EXISTS (SELECT 1 FROM server_members WHERE is_host = 1)` },
    { name: 'attachments_new_table', sql: `CREATE TABLE IF NOT EXISTS attachments_new (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      size INTEGER,
      content_type TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )` },
    { name: 'migrate_attachments', sql: `INSERT OR IGNORE INTO attachments_new (id, message_id, filename, url, size, content_type, created_at)
     SELECT id, CASE WHEN message_id = '' THEN NULL ELSE message_id END, filename, url, size, content_type, created_at
     FROM attachments` },
    { name: 'drop_attachments', sql: `DROP TABLE IF EXISTS attachments` },
    { name: 'rename_attachments_new', sql: `ALTER TABLE attachments_new RENAME TO attachments` },
    { name: 'channel_mutes_table', sql: `CREATE TABLE IF NOT EXISTS channel_mutes (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      muted_until INTEGER DEFAULT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )` },
    { name: 'gifs_table', sql: `CREATE TABLE IF NOT EXISTS gifs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'gif',
      display_name TEXT NOT NULL,
      category TEXT DEFAULT 'uncategorized',
      tags TEXT DEFAULT '',
      pack_name TEXT DEFAULT NULL,
      stored_filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      uploaded_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )` },
    { name: 'idx_gifs_type', sql: `CREATE INDEX IF NOT EXISTS idx_gifs_type ON gifs(type)` },
    { name: 'idx_gifs_category', sql: `CREATE INDEX IF NOT EXISTS idx_gifs_category ON gifs(category)` },
    { name: 'idx_gifs_pack', sql: `CREATE INDEX IF NOT EXISTS idx_gifs_pack ON gifs(type, pack_name)` },
    { name: 'idx_gifs_name', sql: `CREATE INDEX IF NOT EXISTS idx_gifs_name ON gifs(display_name)` },
    { name: 'message_reactions_v1', sql: `CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction_key TEXT NOT NULL,
      reaction_type TEXT NOT NULL DEFAULT 'emoji',
      created_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (message_id, user_id, reaction_key),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )` },
    { name: 'idx_msg_reactions_msg_v1', sql: `CREATE INDEX IF NOT EXISTS idx_msg_reactions_msg ON message_reactions(message_id)` },
    { name: 'message_reactions_new_table', sql: `CREATE TABLE IF NOT EXISTS message_reactions_new (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reaction_key TEXT NOT NULL,
      reaction_type TEXT NOT NULL DEFAULT 'emoji',
      created_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (message_id, user_id, reaction_key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )` },
    { name: 'migrate_message_reactions', sql: `INSERT INTO message_reactions_new (message_id, user_id, reaction_key, reaction_type, created_at)
     SELECT message_id, user_id, reaction_key, reaction_type, created_at FROM message_reactions` },
    { name: 'drop_message_reactions_v1', sql: `DROP TABLE IF EXISTS message_reactions` },
    { name: 'rename_message_reactions_new', sql: `ALTER TABLE message_reactions_new RENAME TO message_reactions` },
    { name: 'idx_msg_reactions_msg_v2', sql: `CREATE INDEX IF NOT EXISTS idx_msg_reactions_msg ON message_reactions(message_id)` },
    { name: 'messages_add_reply_to', sql: `ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT DEFAULT NULL` },
    { name: 'messages_add_reply_username', sql: `ALTER TABLE messages ADD COLUMN reply_to_username TEXT DEFAULT NULL` },
    { name: 'messages_add_reply_content', sql: `ALTER TABLE messages ADD COLUMN reply_to_content TEXT DEFAULT NULL` },
    { name: 'dm_add_reply_to', sql: `ALTER TABLE direct_messages ADD COLUMN reply_to_message_id TEXT DEFAULT NULL` },
    { name: 'dm_add_reply_username', sql: `ALTER TABLE direct_messages ADD COLUMN reply_to_username TEXT DEFAULT NULL` },
    { name: 'dm_add_reply_content', sql: `ALTER TABLE direct_messages ADD COLUMN reply_to_content TEXT DEFAULT NULL` },
    { name: 'bans_table', sql: `CREATE TABLE IF NOT EXISTS bans (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       banned_by TEXT NOT NULL,
       reason TEXT DEFAULT NULL,
       created_at INTEGER DEFAULT (unixepoch()),
       FOREIGN KEY (user_id) REFERENCES users(id),
       FOREIGN KEY (banned_by) REFERENCES users(id)
     )` },
    { name: 'idx_bans_user', sql: `CREATE INDEX IF NOT EXISTS idx_bans_user ON bans(user_id)` },
    { name: 'audit_logs_table', sql: `CREATE TABLE IF NOT EXISTS audit_logs (
       id TEXT PRIMARY KEY,
       action TEXT NOT NULL,
       actor_id TEXT NOT NULL,
       target_id TEXT DEFAULT NULL,
       details TEXT DEFAULT NULL,
       created_at INTEGER DEFAULT (unixepoch()),
       FOREIGN KEY (actor_id) REFERENCES users(id)
     )` },
    { name: 'idx_audit_logs_actor', sql: `CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id)` },
    { name: 'idx_audit_logs_created', sql: `CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)` },
    { name: 'normalize_dm_channels', sql: `UPDATE dm_channels SET user1_id = MIN(user1_id, user2_id), user2_id = MAX(user1_id, user2_id) WHERE user1_id > user2_id` },
    { name: 'idx_server_members_role', sql: `CREATE INDEX IF NOT EXISTS idx_server_members_role ON server_members(role)` },
    { name: 'idx_message_reactions_user', sql: `CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id, reaction_type)` },
    { name: 'idx_attachments_message', sql: `CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)` },
    { name: 'idx_mentions_channel', sql: `CREATE INDEX IF NOT EXISTS idx_mentions_channel ON mentions(channel_id)` },
    { name: 'idx_invite_codes_created', sql: `CREATE INDEX IF NOT EXISTS idx_invite_codes_created ON invite_codes(created_by)` },
    { name: 'idx_server_members_custom_role', sql: `CREATE INDEX IF NOT EXISTS idx_server_members_custom_role ON server_members(custom_role_id)` },
    { name: 'sessions_table', sql: `CREATE TABLE IF NOT EXISTS sessions (
       token_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       created_at INTEGER DEFAULT (unixepoch()),
       revoked_at INTEGER DEFAULT NULL,
       FOREIGN KEY (user_id) REFERENCES users(id)
     )` },
    { name: 'idx_sessions_user', sql: `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)` },
    { name: 'messages_fts', sql: `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content_rowid='rowid')` },
    { name: 'pinned_messages_table', sql: `CREATE TABLE IF NOT EXISTS pinned_messages (
       id TEXT PRIMARY KEY,
       channel_id TEXT NOT NULL,
       message_id TEXT NOT NULL,
       pinned_by TEXT NOT NULL,
       pinned_at INTEGER DEFAULT (unixepoch()),
       FOREIGN KEY (channel_id) REFERENCES channels(id),
       FOREIGN KEY (message_id) REFERENCES messages(id),
       FOREIGN KEY (pinned_by) REFERENCES users(id),
       UNIQUE(channel_id, message_id)
     )` },
    { name: 'channel_categories_table', sql: `CREATE TABLE IF NOT EXISTS channel_categories (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       position INTEGER DEFAULT 0,
       created_at INTEGER DEFAULT (unixepoch())
     )` },
    { name: 'channels_add_category_id', sql: `ALTER TABLE channels ADD COLUMN category_id TEXT DEFAULT NULL` },
    { name: 'link_embeds_table', sql: `CREATE TABLE IF NOT EXISTS link_embeds (
       url TEXT PRIMARY KEY,
       title TEXT DEFAULT NULL,
       description TEXT DEFAULT NULL,
       image TEXT DEFAULT NULL,
       site_name TEXT DEFAULT NULL,
       favicon TEXT DEFAULT NULL,
       fetched_at INTEGER DEFAULT (unixepoch())
     )` },
    { name: 'roles_add_position', sql: `ALTER TABLE roles ADD COLUMN position INTEGER NOT NULL DEFAULT 0` },
    { name: 'roles_add_hoist', sql: `ALTER TABLE roles ADD COLUMN hoist INTEGER NOT NULL DEFAULT 0` },
    { name: 'roles_add_mentionable', sql: `ALTER TABLE roles ADD COLUMN mentionable INTEGER NOT NULL DEFAULT 0` },
    { name: 'roles_add_default_on_join', sql: `ALTER TABLE roles ADD COLUMN default_on_join INTEGER NOT NULL DEFAULT 0` },
    { name: 'set_admin_role_position', sql: `UPDATE roles SET position = 9999 WHERE id = 'admin-role'` },
    { name: 'channel_role_overrides_table', sql: `CREATE TABLE IF NOT EXISTS channel_role_overrides (
       channel_id TEXT NOT NULL,
       role_id TEXT NOT NULL,
       allow_permissions TEXT NOT NULL DEFAULT '{}',
       deny_permissions TEXT NOT NULL DEFAULT '{}',
       PRIMARY KEY (channel_id, role_id),
       FOREIGN KEY (channel_id) REFERENCES channels(id),
       FOREIGN KEY (role_id) REFERENCES roles(id)
     )` },
  ]

  const insertStmt = database.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)')

  for (const { name, sql } of migrations) {
    if (applied.has(name)) continue
    try {
      database.exec(sql)
    } catch (err: any) {
      const msg = err.message || ''
      if (msg.includes('duplicate column') || msg.includes('already exists') || msg.includes('UNIQUE constraint failed')) {
        insertStmt.run(name)
        applied.add(name)
        continue
      }
      console.error(`[DB] Migration "${name}" failed:`, msg.slice(0, 200))
      throw err
    }
    insertStmt.run(name)
    applied.add(name)
  }
}
