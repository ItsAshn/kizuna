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
  const migrations: string[] = [
    `CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER DEFAULT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (created_by) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#5865f2',
      permissions TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch())
    )`,
    `CREATE TABLE IF NOT EXISTS dm_channels (
      id TEXT PRIMARY KEY,
      user1_id TEXT NOT NULL,
      user2_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY (user1_id) REFERENCES users(id),
      FOREIGN KEY (user2_id) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dm_channels_users ON dm_channels(user1_id, user2_id)`,
    `CREATE TABLE IF NOT EXISTS channel_reads (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    )`,
    `CREATE TABLE IF NOT EXISTS dm_reads (
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES dm_channels(id)
    )`,
    `CREATE TABLE IF NOT EXISTS message_edits (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      old_content TEXT NOT NULL,
      edited_by TEXT NOT NULL,
      edited_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (edited_by) REFERENCES users(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mentions_user_read ON mentions(mentioned_user_id, read)`,
    `CREATE INDEX IF NOT EXISTS idx_direct_messages_channel ON direct_messages(channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id)`,
    `ALTER TABLE users ADD COLUMN public_key TEXT DEFAULT NULL`,
    `ALTER TABLE direct_messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN reset_token TEXT DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN reset_token_expires_at INTEGER DEFAULT NULL`,
    `ALTER TABLE users ADD COLUMN token_invalidated_at INTEGER DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS member_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    )`,
    `ALTER TABLE channels ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE channels ADD COLUMN write_role_id TEXT DEFAULT NULL`,
    `INSERT OR IGNORE INTO member_roles (user_id, role_id)
     SELECT user_id, custom_role_id FROM server_members WHERE custom_role_id IS NOT NULL`,
    `ALTER TABLE roles ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
    `INSERT OR IGNORE INTO roles (id, name, color, permissions, is_admin) VALUES
     ('admin-role', 'Admin', '#f59e0b',
      '{"send_messages":true,"manage_channels":true,"delete_messages":true,"kick_members":true,"manage_invites":true}',
      1)`,
    `INSERT OR IGNORE INTO member_roles (user_id, role_id)
     SELECT user_id, 'admin-role' FROM server_members WHERE role = 'admin'
       AND NOT EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = server_members.user_id AND mr.role_id = 'admin-role')`,
    `ALTER TABLE users ADD COLUMN reset_requested_at INTEGER DEFAULT NULL`,
  ]

  for (const sql of migrations) {
    try {
      database.exec(sql)
    } catch {
      // Column/table already exists — skip
    }
  }
}
