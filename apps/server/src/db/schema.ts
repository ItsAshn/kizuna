export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT NULL,
    last_seen_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    topic TEXT DEFAULT NULL,
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_username TEXT NOT NULL,
    content TEXT NOT NULL,
    edited_at INTEGER DEFAULT NULL,
    updated_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    size INTEGER,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (message_id) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT DEFAULT NULL,
    from_id TEXT NOT NULL,
    from_username TEXT NOT NULL,
    to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS server_members (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'member',
    custom_role_id TEXT DEFAULT NULL,
    joined_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL,
    user2_id TEXT NOT NULL,
    last_message_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user1_id) REFERENCES users(id),
    FOREIGN KEY (user2_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_dm_channels_users ON dm_channels(user1_id, user2_id);

  CREATE TABLE IF NOT EXISTS mentions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_username TEXT NOT NULL,
    mentioned_user_id TEXT,
    mention_type TEXT NOT NULL DEFAULT 'user',
    content TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (message_id) REFERENCES messages(id)
  );
`

export const SEED_SQL = `
  INSERT OR IGNORE INTO channels (id, name, type, position) VALUES
    ('general', 'general', 'text', 0),
    ('announcements', 'announcements', 'text', 1),
    ('voice-1', 'Voice 1', 'voice', 2),
    ('voice-2', 'Voice 2', 'voice', 3);
`
