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
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('mmap_size = 268435456')
    db.pragma('cache_size = -64000')
    db.pragma('journal_size_limit = 67108864')
    db.pragma('busy_timeout = 5000')
  }
  return db
}

export function initDb(): Database.Database {
  const database = getDb()
  database.exec(SCHEMA_SQL)
  database.exec(SEED_SQL)
  runMigrations(database)
  validateSchema(database)
  return database
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

export function deleteUserAccount(userId: string, deleteData: boolean): void {
  const db = getDb()

  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM message_reactions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM channel_reads WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM channel_mutes WHERE user_id = ?').run(userId)

    const dmChannelIds = (
      db.prepare('SELECT id FROM dm_channels WHERE user1_id = ? OR user2_id = ?').all(userId, userId) as { id: string }[]
    ).map(r => r.id)

    for (const channelId of dmChannelIds) {
      db.prepare('DELETE FROM dm_reads WHERE channel_id = ?').run(channelId)
      if (deleteData) {
        db.prepare('DELETE FROM direct_messages WHERE channel_id = ?').run(channelId)
      }
    }
    if (deleteData) {
      db.prepare('DELETE FROM dm_reads WHERE user_id = ?').run(userId)
    }
    db.prepare('DELETE FROM dm_channels WHERE user1_id = ? OR user2_id = ?').run(userId, userId)

    if (deleteData) {
      const groupDmChannelIds = (
        db.prepare('SELECT channel_id FROM group_dm_members WHERE user_id = ?').all(userId) as { channel_id: string }[]
      ).map(r => r.channel_id)

      for (const channelId of groupDmChannelIds) {
        db.prepare('DELETE FROM group_dm_messages WHERE channel_id = ? AND from_id = ?').run(channelId, userId)
      }
      db.prepare('DELETE FROM group_dm_messages WHERE from_id = ?').run(userId)
      db.prepare('DELETE FROM direct_messages WHERE from_id = ? OR to_id = ?').run(userId, userId)
      db.prepare('DELETE FROM messages WHERE author_id = ?').run(userId)
      db.prepare('DELETE FROM mentions WHERE author_id = ? OR mentioned_user_id = ?').run(userId, userId)
      db.prepare('DELETE FROM message_edits WHERE edited_by = ?').run(userId)
      db.prepare('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE author_id = ?)').run(userId)
      db.prepare('DELETE FROM polls WHERE created_by = ?').run(userId)
      db.prepare('DELETE FROM webhooks WHERE created_by = ?').run(userId)
      db.prepare('DELETE FROM gifs WHERE uploaded_by = ?').run(userId)
      db.prepare('DELETE FROM threads WHERE creator_id = ?').run(userId)
      db.prepare('DELETE FROM pinned_messages WHERE pinned_by = ?').run(userId)
      db.prepare('DELETE FROM invite_codes WHERE created_by = ?').run(userId)
      db.prepare('DELETE FROM audit_logs WHERE actor_id = ? OR target_id = ?').run(userId, userId)
      db.prepare('DELETE FROM bans WHERE user_id = ? OR banned_by = ?').run(userId, userId)
    } else {
      db.prepare('UPDATE group_dm_channels SET owner_id = NULL WHERE owner_id = ?').run(userId)
    }

    db.prepare('DELETE FROM group_dm_reads WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM group_dm_members WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM group_dm_voice_participants WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM identity_links WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM verification_tokens WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM server_members WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  })()
}

const EXPECTED_SCHEMA: Record<string, string[]> = {
  users: ['id', 'username', 'display_name', 'password_hash', 'avatar', 'banner', 'last_seen_at',
    'public_key', 'key_salt', 'token_invalidated_at', 'reset_token', 'reset_token_expires_at',
    'reset_requested_at', 'backuptoken_hash', 'created_at'],
  channels: ['id', 'name', 'type', 'topic', 'position', 'locked', 'hidden', 'hidden_role_ids', 'write_role_id', 'category_id', 'created_at'],
  messages: ['id', 'channel_id', 'author_id', 'author_username', 'content', 'edited_at',
    'updated_at', 'created_at', 'reply_to_message_id', 'reply_to_username', 'reply_to_content',
    'author_display_name', 'author_avatar', 'webhook_id'],
  direct_messages: ['id', 'channel_id', 'from_id', 'from_username', 'to_id', 'content',
    'encrypted', 'edited_at', 'created_at', 'reply_to_message_id', 'reply_to_username', 'reply_to_content'],
  server_members: ['user_id', 'role', 'is_host', 'custom_role_id', 'joined_at'],
  roles: ['id', 'name', 'color', 'permissions', 'is_admin', 'position', 'hoist', 'mentionable', 'default_on_join', 'created_at'],
  member_roles: ['user_id', 'role_id'],
  dm_channels: ['id', 'user1_id', 'user2_id', 'last_message_at', 'created_at'],
  mentions: ['id', 'message_id', 'channel_id', 'author_id', 'author_username',
    'mentioned_user_id', 'mention_type', 'content', 'read', 'created_at'],
  attachments: ['id', 'message_id', 'filename', 'url', 'size', 'content_type', 'created_at'],
  channel_reads: ['user_id', 'channel_id', 'last_read_at'],
  dm_reads: ['user_id', 'channel_id', 'last_read_at'],
  message_edits: ['id', 'message_id', 'old_content', 'edited_by', 'edited_at'],
  channel_mutes: ['user_id', 'channel_id', 'muted_until'],
  gifs: ['id', 'type', 'display_name', 'category', 'tags', 'pack_name',
    'stored_filename', 'original_filename', 'file_size', 'width', 'height', 'uploaded_by', 'created_at'],
  message_reactions: ['message_id', 'user_id', 'reaction_key', 'reaction_type', 'created_at'],
  server_settings: ['key', 'value'],
  invite_codes: ['code', 'created_by', 'max_uses', 'uses', 'expires_at', 'created_at'],
  bans: ['id', 'user_id', 'banned_by', 'reason', 'created_at'],
  audit_logs: ['id', 'action', 'actor_id', 'target_id', 'details', 'created_at'],
  sessions: ['token_id', 'user_id', 'created_at', 'revoked_at'],
  pinned_messages: ['id', 'channel_id', 'message_id', 'pinned_by', 'pinned_at'],
  channel_categories: ['id', 'name', 'position', 'created_at'],
  threads: ['id', 'channel_id', 'name', 'creator_id', 'created_at', 'message_count', 'last_message_at'],
  link_embeds: ['url', 'title', 'description', 'image', 'site_name', 'favicon', 'fetched_at'],
  channel_role_overrides: ['channel_id', 'role_id', 'allow_permissions', 'deny_permissions'],
  group_dm_channels: ['id', 'name', 'owner_id', 'avatar', 'last_message_at', 'created_at'],
  group_dm_members: ['channel_id', 'user_id', 'joined_at'],
  group_dm_messages: ['id', 'channel_id', 'from_id', 'from_username', 'content', 'encrypted', 'edited_at', 'created_at', 'reply_to_message_id', 'reply_to_username', 'reply_to_content'],
  group_dm_reads: ['user_id', 'channel_id', 'last_read_at'],
  group_dm_voice_participants: ['id', 'channel_id', 'user_id', 'joined_at', 'left_at'],
  registry_servers: ['url', 'name', 'description', 'icon', 'password_protected', 'player_count', 'last_heartbeat'],
  _migrations: ['name', 'applied_at'],
}

function validateSchema(database: Database.Database): void {
  const tableNames = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name"
  ).all() as { name: string }[]

  const existingTables = new Set(tableNames.map(r => r.name))
  const missing: string[] = []

  for (const [table, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
    if (!existingTables.has(table)) {
      missing.push(`  Table "${table}" is missing — migrations may not have run`)
      continue
    }

    const cols = database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
    const colNames = new Set(cols.map(c => c.name))

    for (const col of expectedCols) {
      if (!colNames.has(col)) {
        missing.push(`  Column "${table}.${col}" is missing — migration may not have run`)
      }
    }
  }

  if (missing.length > 0) {
    console.error('[DB] Schema validation failed — missing tables/columns:');
    for (const m of missing) console.error(m);
    console.error('[DB] The database is out of sync with the current server version.');
    console.error('[DB] Ensure all migrations have run or restore from a backup.');
    process.exit(1);
  }
}

function columnExists(database: Database.Database, table: string, column: string): boolean {
  const cols = database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
  return cols.some(c => c.name === column)
}

function tableExists(database: Database.Database, table: string): boolean {
  const row = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table)
  return !!row
}

function indexExists(database: Database.Database, name: string): boolean {
  const row = database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(name)
  return !!row
}

function seedPreExistingMigrations(database: Database.Database): void {
  const row = database.prepare('SELECT 1 FROM _migrations LIMIT 1').get()
  if (row) return

  const insert = database.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)')

  const checks: [string, boolean][] = [
    ['server_settings_table', tableExists(database, 'server_settings')],
    ['invite_codes_table', tableExists(database, 'invite_codes')],
    ['roles_initial', tableExists(database, 'roles')],
    ['dm_channels_table', tableExists(database, 'dm_channels')],
    ['idx_dm_channels_users', indexExists(database, 'idx_dm_channels_users')],
    ['channel_reads_table', tableExists(database, 'channel_reads')],
    ['dm_reads_table', tableExists(database, 'dm_reads')],
    ['message_edits_table', tableExists(database, 'message_edits')],
    ['idx_messages_channel_created', indexExists(database, 'idx_messages_channel_created')],
    ['idx_mentions_user_read', indexExists(database, 'idx_mentions_user_read')],
    ['idx_direct_messages_channel', indexExists(database, 'idx_direct_messages_channel')],
    ['idx_message_edits_message', indexExists(database, 'idx_message_edits_message')],
    ['users_add_public_key', columnExists(database, 'users', 'public_key')],
    ['users_add_key_salt', columnExists(database, 'users', 'key_salt')],
    ['dm_add_encrypted', columnExists(database, 'direct_messages', 'encrypted')],
    ['dm_add_edited_at', columnExists(database, 'direct_messages', 'edited_at')],
    ['users_add_reset_token', columnExists(database, 'users', 'reset_token')],
    ['users_add_reset_token_expires', columnExists(database, 'users', 'reset_token_expires_at')],
    ['users_add_token_invalidated_at', columnExists(database, 'users', 'token_invalidated_at')],
    ['member_roles_table', tableExists(database, 'member_roles')],
    ['channels_add_locked', columnExists(database, 'channels', 'locked')],
    ['channels_add_write_role_id', columnExists(database, 'channels', 'write_role_id')],
    ['channels_add_hidden', columnExists(database, 'channels', 'hidden')],
    ['channels_add_hidden_role_ids', columnExists(database, 'channels', 'hidden_role_ids')],
    ['migrate_custom_role_to_member_roles', tableExists(database, 'member_roles')],
    ['roles_add_is_admin', columnExists(database, 'roles', 'is_admin')],
    ['seed_admin_role', tableExists(database, 'roles')],
    ['assign_admin_role', tableExists(database, 'member_roles')],
    ['users_add_reset_requested_at', columnExists(database, 'users', 'reset_requested_at')],
    ['users_add_backuptoken_hash', columnExists(database, 'users', 'backuptoken_hash')],
    ['server_members_add_is_host', columnExists(database, 'server_members', 'is_host')],
    ['seed_first_host', columnExists(database, 'server_members', 'is_host')],
    ['attachments_new_table', false],
    ['migrate_attachments', false],
    ['drop_attachments', false],
    ['rename_attachments_new', false],
    ['channel_mutes_table', tableExists(database, 'channel_mutes')],
    ['gifs_table', tableExists(database, 'gifs')],
    ['idx_gifs_type', indexExists(database, 'idx_gifs_type')],
    ['idx_gifs_category', indexExists(database, 'idx_gifs_category')],
    ['idx_gifs_pack', indexExists(database, 'idx_gifs_pack')],
    ['idx_gifs_name', indexExists(database, 'idx_gifs_name')],
    ['message_reactions_v1', false],
    ['idx_msg_reactions_msg_v1', false],
    ['message_reactions_new_table', tableExists(database, 'message_reactions_new')],
    ['migrate_message_reactions', false],
    ['drop_message_reactions_v1', false],
    ['rename_message_reactions_new', false],
    ['idx_msg_reactions_msg_v2', indexExists(database, 'idx_msg_reactions_msg')],
    ['messages_add_reply_to', columnExists(database, 'messages', 'reply_to_message_id')],
    ['messages_add_reply_username', columnExists(database, 'messages', 'reply_to_username')],
    ['messages_add_reply_content', columnExists(database, 'messages', 'reply_to_content')],
    ['dm_add_reply_to', columnExists(database, 'direct_messages', 'reply_to_message_id')],
    ['dm_add_reply_username', columnExists(database, 'direct_messages', 'reply_to_username')],
    ['dm_add_reply_content', columnExists(database, 'direct_messages', 'reply_to_content')],
    ['bans_table', tableExists(database, 'bans')],
    ['idx_bans_user', indexExists(database, 'idx_bans_user')],
    ['audit_logs_table', tableExists(database, 'audit_logs')],
    ['idx_audit_logs_actor', indexExists(database, 'idx_audit_logs_actor')],
    ['idx_audit_logs_created', indexExists(database, 'idx_audit_logs_created')],
    ['normalize_dm_channels', tableExists(database, 'dm_channels')],
    ['idx_server_members_role', indexExists(database, 'idx_server_members_role')],
    ['idx_message_reactions_user', indexExists(database, 'idx_message_reactions_user')],
    ['idx_attachments_message', indexExists(database, 'idx_attachments_message')],
    ['idx_mentions_channel', indexExists(database, 'idx_mentions_channel')],
    ['idx_invite_codes_created', indexExists(database, 'idx_invite_codes_created')],
    ['idx_server_members_custom_role', indexExists(database, 'idx_server_members_custom_role')],
    ['sessions_table', tableExists(database, 'sessions')],
    ['idx_sessions_user', indexExists(database, 'idx_sessions_user')],
    ['messages_fts', tableExists(database, 'messages_fts')],
    ['pinned_messages_table', tableExists(database, 'pinned_messages')],
    ['channel_categories_table', tableExists(database, 'channel_categories')],
    ['channels_add_category_id', columnExists(database, 'channels', 'category_id')],
    ['link_embeds_table', tableExists(database, 'link_embeds')],
    ['roles_add_position', columnExists(database, 'roles', 'position')],
    ['roles_add_hoist', columnExists(database, 'roles', 'hoist')],
    ['roles_add_mentionable', columnExists(database, 'roles', 'mentionable')],
    ['roles_add_default_on_join', columnExists(database, 'roles', 'default_on_join')],
    ['set_admin_role_position', columnExists(database, 'roles', 'position')],
    ['channel_role_overrides_table', tableExists(database, 'channel_role_overrides')],
    ['users_add_banner', columnExists(database, 'users', 'banner')],
    ['gifs_add_suggested_tags', columnExists(database, 'gifs', 'suggested_tags')],
    ['users_add_status_text', columnExists(database, 'users', 'status_text')],
    ['users_add_status_emoji', columnExists(database, 'users', 'status_emoji')],
    ['users_add_status_sticker_id', columnExists(database, 'users', 'status_sticker_id')],
    ['threads_table', tableExists(database, 'threads')],
    ['messages_add_thread_id', columnExists(database, 'messages', 'thread_id')],
    ['idx_threads_channel', indexExists(database, 'idx_threads_channel')],
    ['idx_messages_thread', indexExists(database, 'idx_messages_thread')],
    ['messages_fts_rebuild', tableExists(database, 'messages_fts')],
    ['group_dm_channels_table', tableExists(database, 'group_dm_channels')],
    ['group_dm_members_table', tableExists(database, 'group_dm_members')],
    ['idx_group_dm_members_user', indexExists(database, 'idx_group_dm_members_user')],
    ['group_dm_messages_table', tableExists(database, 'group_dm_messages')],
    ['idx_group_dm_messages_channel', indexExists(database, 'idx_group_dm_messages_channel')],
    ['group_dm_reads_table', tableExists(database, 'group_dm_reads')],
    ['group_dm_voice_participants_table', tableExists(database, 'group_dm_voice_participants')],
    ['idx_group_dm_vp_channel', indexExists(database, 'idx_group_dm_vp_channel')],
    ['idx_group_dm_vp_user', indexExists(database, 'idx_group_dm_vp_user')],
    ['registry_servers_table', tableExists(database, 'registry_servers')],
  ]

  for (const [name, isApplied] of checks) {
    if (isApplied) insert.run(name)
  }
}

function runMigrations(database: Database.Database): void {
  seedPreExistingMigrations(database)

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
    { name: 'channels_add_hidden', sql: `ALTER TABLE channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0` },
    { name: 'channels_add_hidden_role_ids', sql: `ALTER TABLE channels ADD COLUMN hidden_role_ids TEXT DEFAULT NULL` },
    { name: 'migrate_custom_role_to_member_roles', sql: `INSERT OR IGNORE INTO member_roles (user_id, role_id)
     SELECT user_id, custom_role_id FROM server_members WHERE custom_role_id IS NOT NULL` },
    { name: 'roles_add_is_admin', sql: `ALTER TABLE roles ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0` },
    { name: 'seed_admin_role', sql: `INSERT OR IGNORE INTO roles (id, name, color, permissions, is_admin) VALUES
     ('admin-role', 'Admin', '#f59e0b',
      '{"send_messages":true,"send_dm_messages":true,"create_group_dms":true,"add_reactions":true,"upload_attachments":true,"delete_messages":true,"manage_channels":true,"manage_roles":true,"kick_members":true,"manage_invites":true,"use_voice":true,"initiate_dm_calls":true}',
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
    { name: 'users_add_banner', sql: `ALTER TABLE users ADD COLUMN banner TEXT DEFAULT NULL` },
    { name: 'gifs_add_suggested_tags', sql: `ALTER TABLE gifs ADD COLUMN suggested_tags TEXT DEFAULT ''` },
    { name: 'users_add_status_text', sql: `ALTER TABLE users ADD COLUMN status_text TEXT DEFAULT NULL` },
    { name: 'users_add_status_emoji', sql: `ALTER TABLE users ADD COLUMN status_emoji TEXT DEFAULT NULL` },
    { name: 'users_add_status_sticker_id', sql: `ALTER TABLE users ADD COLUMN status_sticker_id TEXT DEFAULT NULL` },
    { name: 'users_add_status', sql: `ALTER TABLE users ADD COLUMN status TEXT DEFAULT NULL` },
    { name: 'threads_table', sql: `CREATE TABLE IF NOT EXISTS threads (
       id TEXT PRIMARY KEY,
       channel_id TEXT NOT NULL,
       name TEXT NOT NULL,
       creator_id TEXT NOT NULL,
       created_at INTEGER DEFAULT (unixepoch()),
       message_count INTEGER DEFAULT 1,
       last_message_at INTEGER DEFAULT (unixepoch()),
       FOREIGN KEY (channel_id) REFERENCES channels(id),
       FOREIGN KEY (creator_id) REFERENCES users(id)
     )` },
    { name: 'messages_add_thread_id', sql: `ALTER TABLE messages ADD COLUMN thread_id TEXT DEFAULT NULL` },
    { name: 'idx_threads_channel', sql: `CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id)` },
    { name: 'idx_messages_thread', sql: `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)` },
    { name: 'messages_fts_rebuild', sql: `
      DROP TABLE IF EXISTS messages_fts;
      CREATE VIRTUAL TABLE messages_fts USING fts5(source, message_id, content);
      INSERT INTO messages_fts(source, message_id, content)
        SELECT 'channel', id, content FROM messages WHERE content IS NOT NULL AND content != '';
      INSERT INTO messages_fts(source, message_id, content)
        SELECT 'dm', id, content FROM direct_messages WHERE content IS NOT NULL AND content != '';
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
      BEGIN
        INSERT INTO messages_fts(source, message_id, content) VALUES ('channel', NEW.id, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE source='channel' AND message_id=OLD.id;
        INSERT INTO messages_fts(source, message_id, content) VALUES ('channel', NEW.id, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
      BEGIN
        DELETE FROM messages_fts WHERE source='channel' AND message_id=OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS dm_fts_insert AFTER INSERT ON direct_messages
      BEGIN
        INSERT INTO messages_fts(source, message_id, content) VALUES ('dm', NEW.id, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS dm_fts_update AFTER UPDATE ON direct_messages
      BEGIN
        DELETE FROM messages_fts WHERE source='dm' AND message_id=OLD.id;
        INSERT INTO messages_fts(source, message_id, content) VALUES ('dm', NEW.id, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS dm_fts_delete AFTER DELETE ON direct_messages
      BEGIN
        DELETE FROM messages_fts WHERE source='dm' AND message_id=OLD.id;
      END;
    ` },
    { name: 'group_dm_channels_table', sql: `CREATE TABLE IF NOT EXISTS group_dm_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      avatar TEXT DEFAULT NULL,
      last_message_at INTEGER DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )` },
    { name: 'group_dm_members_table', sql: `CREATE TABLE IF NOT EXISTS group_dm_members (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (channel_id, user_id),
      FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )` },
    { name: 'idx_group_dm_members_user', sql: `CREATE INDEX IF NOT EXISTS idx_group_dm_members_user ON group_dm_members(user_id)` },
    { name: 'group_dm_messages_table', sql: `CREATE TABLE IF NOT EXISTS group_dm_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      from_username TEXT NOT NULL,
      content TEXT NOT NULL,
      encrypted INTEGER NOT NULL DEFAULT 0,
      edited_at INTEGER DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      reply_to_message_id TEXT DEFAULT NULL,
      reply_to_username TEXT DEFAULT NULL,
      reply_to_content TEXT DEFAULT NULL,
      FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id)
    )` },
    { name: 'idx_group_dm_messages_channel', sql: `CREATE INDEX IF NOT EXISTS idx_group_dm_messages_channel ON group_dm_messages(channel_id, created_at)` },
    { name: 'group_dm_reads_table', sql: `CREATE TABLE IF NOT EXISTS group_dm_reads (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id)
    )` },
    { name: 'group_dm_voice_participants_table', sql: `CREATE TABLE IF NOT EXISTS group_dm_voice_participants (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER DEFAULT NULL,
      FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )` },
    { name: 'idx_group_dm_vp_channel', sql: `CREATE INDEX IF NOT EXISTS idx_group_dm_vp_channel ON group_dm_voice_participants(channel_id)` },
    { name: 'idx_group_dm_vp_user', sql: `CREATE INDEX IF NOT EXISTS idx_group_dm_vp_user ON group_dm_voice_participants(user_id)` },
    { name: 'group_dm_fts', sql: `
      INSERT INTO messages_fts(source, message_id, content)
        SELECT 'group_dm', id, content FROM group_dm_messages WHERE content IS NOT NULL AND content != '';
      CREATE TRIGGER IF NOT EXISTS group_dm_fts_insert AFTER INSERT ON group_dm_messages
      BEGIN
        INSERT INTO messages_fts(source, message_id, content) VALUES ('group_dm', NEW.id, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS group_dm_fts_update AFTER UPDATE ON group_dm_messages
      BEGIN
        DELETE FROM messages_fts WHERE source='group_dm' AND message_id=OLD.id;
        INSERT INTO messages_fts(source, message_id, content) VALUES ('group_dm', NEW.id, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS group_dm_fts_delete AFTER DELETE ON group_dm_messages
      BEGIN
        DELETE FROM messages_fts WHERE source='group_dm' AND message_id=OLD.id;
      END;
    ` },
    { name: 'registry_servers_table', sql: `CREATE TABLE IF NOT EXISTS registry_servers (
      url TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT DEFAULT NULL,
      password_protected INTEGER NOT NULL DEFAULT 0,
      player_count INTEGER NOT NULL DEFAULT 0,
      last_heartbeat INTEGER NOT NULL
    )` },
    { name: 'polls_tables', sql: `
      CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL DEFAULT 'channel',
        message_id TEXT NOT NULL,
        question TEXT NOT NULL,
        allow_multiple INTEGER NOT NULL DEFAULT 0,
        closes_at INTEGER DEFAULT NULL,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS poll_options (
        id TEXT PRIMARY KEY,
        poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS poll_votes (
        id TEXT PRIMARY KEY,
        poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(poll_id, user_id, option_id)
      );
    ` },
    { name: 'webhooks_table', sql: `
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        avatar TEXT DEFAULT NULL,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    ` },
    { name: 'messages_add_author_display_name', sql: `ALTER TABLE messages ADD COLUMN author_display_name TEXT DEFAULT NULL` },
    { name: 'messages_add_author_avatar', sql: `ALTER TABLE messages ADD COLUMN author_avatar TEXT DEFAULT NULL` },
    { name: 'messages_add_webhook_id', sql: `ALTER TABLE messages ADD COLUMN webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL` },
    { name: 'polls_remove_channel_fk', sql: `
      CREATE TABLE IF NOT EXISTS polls_new (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL DEFAULT 'channel',
        message_id TEXT NOT NULL,
        question TEXT NOT NULL,
        allow_multiple INTEGER NOT NULL DEFAULT 0,
        closes_at INTEGER DEFAULT NULL,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO polls_new (id, channel_id, channel_type, message_id, question, allow_multiple, closes_at, created_by, created_at)
        SELECT id, channel_id, 'channel', message_id, question, allow_multiple, closes_at, created_by, created_at FROM polls;
      DROP TABLE polls;
      ALTER TABLE polls_new RENAME TO polls;
    ` },
  ]

  const insertStmt = database.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)')

  for (const { name, sql } of migrations) {
    if (applied.has(name)) continue
    try {
      database.exec(sql)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
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
