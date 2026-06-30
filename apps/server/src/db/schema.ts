export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT NULL,
    banner TEXT DEFAULT NULL,
    last_seen_at INTEGER DEFAULT NULL,
    public_key TEXT DEFAULT NULL,
    key_salt TEXT DEFAULT NULL,
    token_invalidated_at INTEGER DEFAULT NULL,
    reset_token TEXT DEFAULT NULL,
    reset_token_expires_at INTEGER DEFAULT NULL,
    reset_requested_at INTEGER DEFAULT NULL,
    backuptoken_hash TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    topic TEXT DEFAULT NULL,
    position INTEGER DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    write_role_id TEXT DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channel_role_overrides (
    channel_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    allow_permissions TEXT NOT NULL DEFAULT '{}',
    deny_permissions TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (channel_id, role_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (role_id) REFERENCES roles(id)
  );

  CREATE TABLE IF NOT EXISTS group_dm_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    avatar TEXT DEFAULT NULL,
    last_message_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS group_dm_members (
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (channel_id, user_id),
    FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_dm_members_user ON group_dm_members(user_id);

  CREATE TABLE IF NOT EXISTS group_dm_messages (
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
  );

  CREATE INDEX IF NOT EXISTS idx_group_dm_messages_channel ON group_dm_messages(channel_id, created_at);

  CREATE TABLE IF NOT EXISTS group_dm_reads (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id)
  );

  CREATE TABLE IF NOT EXISTS group_dm_voice_participants (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER DEFAULT NULL,
    FOREIGN KEY (channel_id) REFERENCES group_dm_channels(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_dm_vp_channel ON group_dm_voice_participants(channel_id);
  CREATE INDEX IF NOT EXISTS idx_group_dm_vp_user ON group_dm_voice_participants(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_username TEXT NOT NULL,
    content TEXT NOT NULL,
    edited_at INTEGER DEFAULT NULL,
    updated_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    reply_to_message_id TEXT DEFAULT NULL,
    reply_to_username TEXT DEFAULT NULL,
    reply_to_content TEXT DEFAULT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    filename TEXT NOT NULL,
    url TEXT NOT NULL,
    size INTEGER,
    content_type TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT DEFAULT NULL,
    from_id TEXT NOT NULL,
    from_username TEXT NOT NULL,
    to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    edited_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    reply_to_message_id TEXT DEFAULT NULL,
    reply_to_username TEXT DEFAULT NULL,
    reply_to_content TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS server_members (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'member',
    is_host INTEGER NOT NULL DEFAULT 0,
    custom_role_id TEXT DEFAULT NULL,
    joined_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS member_roles (
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (role_id) REFERENCES roles(id)
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

  CREATE TABLE IF NOT EXISTS server_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    max_uses INTEGER DEFAULT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER DEFAULT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#5865f2',
    permissions TEXT NOT NULL DEFAULT '{}',
    is_admin INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    hoist INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 0,
    default_on_join INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS channel_reads (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );

  CREATE TABLE IF NOT EXISTS dm_reads (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (channel_id) REFERENCES dm_channels(id)
  );

  CREATE TABLE IF NOT EXISTS message_edits (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    old_content TEXT NOT NULL,
    edited_by TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (edited_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS channel_mutes (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    muted_until INTEGER DEFAULT NULL,
    PRIMARY KEY (user_id, channel_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );

  CREATE TABLE IF NOT EXISTS gifs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'gif',
    display_name TEXT NOT NULL,
    category TEXT DEFAULT 'uncategorized',
    tags TEXT DEFAULT '',
    suggested_tags TEXT DEFAULT '',
    pack_name TEXT DEFAULT NULL,
    stored_filename TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    uploaded_by TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_gifs_type ON gifs(type);
  CREATE INDEX IF NOT EXISTS idx_gifs_category ON gifs(category);
  CREATE INDEX IF NOT EXISTS idx_gifs_pack ON gifs(type, pack_name);
  CREATE INDEX IF NOT EXISTS idx_gifs_name ON gifs(display_name);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reaction_key TEXT NOT NULL,
    reaction_type TEXT NOT NULL DEFAULT 'emoji',
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_id, reaction_key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_reactions_msg ON message_reactions(message_id);

  CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_mentions_user_read ON mentions(mentioned_user_id, read);
  CREATE INDEX IF NOT EXISTS idx_direct_messages_channel ON direct_messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id);

  CREATE TABLE IF NOT EXISTS sessions (
    token_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    revoked_at INTEGER DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS registry_servers (
    url TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT DEFAULT NULL,
    password_protected INTEGER NOT NULL DEFAULT 0,
    player_count INTEGER NOT NULL DEFAULT 0,
    last_heartbeat INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS identity_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    linked_server_url TEXT NOT NULL,
    linked_user_id TEXT NOT NULL,
    linked_username TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 0,
    linked_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_links_user_server
    ON identity_links(user_id, linked_server_url);

  CREATE TABLE IF NOT EXISTS verification_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`

export const SEED_SQL = `
  INSERT OR IGNORE INTO channels (id, name, type, position) VALUES
    ('general', 'general', 'text', 0),
    ('announcements', 'announcements', 'text', 1),
    ('voice-1', 'Voice 1', 'voice', 2),
    ('voice-2', 'Voice 2', 'voice', 3);
`
