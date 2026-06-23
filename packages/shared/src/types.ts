/** A server saved in the user's server list (client-side only). */
export interface SavedServer {
  /** Unique identifier (UUID). */
  id: string;
  /** Display name of the server. */
  name: string;
  /** Base URL of the server's API (e.g. https://myserver.example.com). */
  url: string;
  /** Optional icon URL. */
  icon?: string;
  /** Folder name for grouping servers (e.g. "Gaming", "Work"). */
  folder?: string | null;
  /** Timestamp when the server was added (epoch milliseconds). */
  addedAt: number;
}

/** User presence status. */
export type UserStatus = 'online' | 'idle' | 'busy' | 'offline';

export type UserActivityType = 'game' | 'music' | 'video' | 'other';

export interface UserActivity {
  type: UserActivityType;
  name: string;
  details?: string;
  state?: string;
  timestamps?: { start?: number };
}

/** Shared fields between User and Member. */
export interface BaseUser {
  id: string;
  username: string;
  display_name: string;
  avatar?: string;
  banner?: string;
  role?: 'admin' | 'member';
  is_host?: boolean;
  status?: UserStatus;
  status_text?: string | null;
  status_emoji?: string | null;
  activity?: UserActivity | null;
}

/** Server-side or self-represented user with security fields. */
export interface User extends BaseUser {
  created_at: number;
  /** Epoch seconds of last activity. `null` if never seen. */
  last_seen_at?: number | null;
  /** Base64-encoded NaCl public key. */
  public_key?: string | null;
  /** Base64-encoded key derivation salt. */
  key_salt?: string | null;
  /** Permission map (key = permission string, value = granted). */
  permissions?: Record<string, boolean>;
}

/** A text or voice channel. */
export interface Channel {
  id: string;
  name: string;
  type: 'text' | 'voice';
  topic?: string | null;
  position: number;
  locked: boolean;
  write_role_id?: string | null;
  write_role_name?: string | null;
  category_id?: string | null;
  created_at: number;
}

/** A chat message. */
export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  /** Author username (may be denormalized). */
  username?: string;
  /** Author display name (may be denormalized). */
  display_name?: string;
  /** Author avatar URL (may be denormalized). */
  avatar?: string;
  /** Message body (may be encrypted JSON). */
  content: string;
  /** 1 if content is encrypted (E2E DM). */
  encrypted?: number;
  /** Epoch seconds. */
  created_at: number;
  /** Epoch seconds of last edit. */
  edited_at?: number | null;
  /** Epoch seconds of last update (fallback). */
  updated_at?: number | null;
  reactions?: MessageReaction[];
  reply_to_message_id?: string | null;
  reply_to_username?: string | null;
  reply_to_content?: string | null;
  thread_id?: string | null;
}

export type ReactionType = 'emoji' | 'sticker';

export interface ReactionUser {
  user_id: string;
  username: string;
}

/** Aggregated reaction on a message. */
export interface MessageReaction {
  /** Emoji character or sticker key. */
  reaction_key: string;
  reaction_type: ReactionType;
  /** Total count. */
  count: number;
  /** Users who reacted. */
  users: ReactionUser[];
}

export interface MessageEdit {
  id: string;
  message_id: string;
  old_content: string;
  edited_by: string;
  edited_at: number;
}

export interface PinnedMessage {
  id: string;
  messageId: string;
  channelId: string;
  pinnedBy: string;
  pinnedByUsername?: string;
  pinnedAt: number;
  content: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName?: string;
  authorAvatar?: string;
}

export interface Thread {
  id: string;
  channel_id: string;
  name: string;
  creator_id: string;
  created_at: number;
  message_count: number;
  last_message_at: number;
}

/** Member of a server (as seen by other members). */
export interface Member extends BaseUser {
  /** Custom roles assigned to this member. */
  custom_roles?: CustomRole[];
  /** Legacy single role reference (deprecated, use custom_roles). */
  custom_role_id?: string | null;
  custom_role_name?: string | null;
  custom_role_color?: string | null;
  /** Hoisted (displayed separately) role. */
  hoist_role_id?: string | null;
  hoist_role_name?: string | null;
  hoist_role_color?: string | null;
  /** Timestamp when a password reset was requested. */
  reset_requested_at?: number | null;
  /** Epoch seconds of last activity. */
  last_seen_at?: number | null;
  /** Timestamp when the user created their account (epoch milliseconds). */
  created_at?: number | null;
  /** Timestamp when the user joined this server (epoch milliseconds). */
  joined_at?: number | null;
}

/** Admin user info for display purposes. */
export type AdminInfo = Pick<User, 'username' | 'display_name'>;

/** Recognized permission keys. */
export type Permission =
  | 'send_messages'
  | 'send_dm_messages'
  | 'create_group_dms'
  | 'add_reactions'
  | 'upload_attachments'
  | 'delete_messages'
  | 'manage_channels'
  | 'manage_roles'
  | 'kick_members'
  | 'manage_invites'
  | 'use_voice'
  | 'initiate_dm_calls';

/** A custom role within a server. */
export interface CustomRole {
  id: string;
  name: string;
  /** Hex color (e.g. '#5865f2'). */
  color: string;
  /** Map of permission key → granted flag. */
  permissions: Partial<Record<Permission, boolean>>;
  is_admin?: boolean;
  position?: number;
  /** Whether this role is shown separately in the member list. */
  hoist?: boolean;
  /** Whether this role can be @mentioned. */
  mentionable?: boolean;
  /** Whether new members get this role automatically. */
  default_on_join?: boolean;
  created_at?: number;
}

/** Voice connection quality level. */
export type ConnectionQuality = 'good' | 'fair' | 'poor';

/** A participant in a voice channel. */
export interface VoicePeer {
  /** Peer identifier (unique per connection). */
  id: string;
  userId: string;
  username: string;
  speaking: boolean;
  muted: boolean;
  connectionQuality?: ConnectionQuality;
}

/** WebRTC RTP capabilities (codec negotiation). */
export interface RtpCapabilities {
  codecs?: Array<{
    mimeType: string;
    kind: 'audio' | 'video';
    clockRate: number;
    channels?: number;
    parameters?: Record<string, unknown>;
    rtcpFeedback?: Array<{
      type: string;
      parameter?: string;
    }>;
  }>;
  headerExtensions?: Array<{
    kind: 'audio' | 'video';
    uri: string;
    preferredId: number;
    preferredEncrypt?: boolean;
    direction?: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive';
  }>;
}

/** ICE (STUN/TURN) server configuration. */
export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

/** Response from the server when joining a voice channel. */
export interface VoiceJoinResponse {
  rtpCapabilities?: RtpCapabilities;
  routerRtpCapabilities?: RtpCapabilities;
  peers?: VoicePeer[];
  iceServers?: IceServer[];
  error?: string;
}

export interface VoiceError {
  type:
    | 'permission_denied'
    | 'device_not_found'
    | 'device_in_use'
    | 'transport_failed'
    | 'unknown';
  message: string;
}

/** An invite code for joining a server. */
export interface InviteCode {
  code: string;
  created_by?: string;
  /** Max number of uses (`null` = unlimited). */
  max_uses: number | null;
  uses: number;
  /** Epoch milliseconds (`null` = never). */
  expires_at: number | null;
  created_at?: number;
}

/** Authenticated session on a server. */
export interface ServerSession {
  serverId: string;
  token: string;
  user: User;
}

/** Direct message channel metadata. */
export interface DMChannelData {
  id: string;
  other_user_id: string;
  other_username: string;
  other_display_name: string;
  other_avatar: string | null;
  /** Base64-encoded NaCl public key of the other user (for E2E). */
  other_public_key: string | null;
  created_at: number;
  last_message_at: number | null;
}

/** A member of a group DM channel. */
export interface GroupDMMember {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  public_key: string | null;
  joined_at: number;
}

/** Group DM channel metadata. */
export interface GroupDMChannelData {
  id: string;
  name: string;
  owner_id: string;
  avatar: string | null;
  members: GroupDMMember[];
  created_at: number;
  last_message_at: number | null;
}

/** File attachment metadata. */
export interface FileAttachment {
  id: string;
  message_id: string | null;
  filename: string;
  /** Full URL to download the attachment. */
  url: string;
  /** File size in bytes. */
  size: number;
  content_type?: string;
  created_at: number;
}

/** Mention entry in a message. */
export interface Mention {
  id: string;
  message_id: string;
  channel_id: string;
  author_id: string;
  author_username: string;
  mentioned_user_id: string | null;
  mention_type: 'everyone' | 'here' | 'user' | 'role';
  content: string;
  /** Whether the mention has been read (0 or 1). */
  read: number;
  created_at: number;
}

export interface UnreadCount {
  channel_id: string;
  count: number;
}

export interface ScreenSharePeer {
  peerId: string;
  userId: string;
  username: string;
}

export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
}

/** Public information about a server (before joining). */
export interface ServerInfo {
  name: string;
  description: string;
  passwordProtected: boolean;
  icon: string | null;
  serverUrl: string | null;
  hasBackground: boolean;
  backgroundBlur: number;
  customCss: string | null;
  voiceBitrateKbps: number;
  gifsEnabled: boolean;
}

export interface PublicServerEntry {
  url: string;
  name: string;
  description: string;
  icon: string | null;
  passwordProtected: boolean;
  playerCount: number;
}

export type GifType = 'gif' | 'sticker';

export interface GifInfo {
  id: string;
  type: GifType;
  display_name: string;
  category: string;
  tags: string;
  suggested_tags: string;
  pack_name: string | null;
  file_url: string;
  file_size: number;
  width: number | null;
  height: number | null;
  created_at: number;
}

/** Proof-of-Work challenge issued by the server for registration. */
export interface PoWChallenge {
  /** Hex challenge string to hash against. */
  challenge: string;
  /** Number of leading zero bits required in the hash. */
  difficulty: number;
  /** Epoch milliseconds when the challenge expires. */
  expiresAt: number;
}

/** Per-channel mute status. */
export interface ChannelMute {
  channel_id: string;
  /** Epoch milliseconds until muted (`null` = permanent). */
  muted_until: number | null;
}

/** URL embed/unfurl result. */
export interface LinkEmbed {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  favicon?: string;
}

/** Admin analytics for group DM voice usage. */
export interface GroupDMVoiceStats {
  total_channels: number;
  total_members: number;
  active_voice_sessions: number;
  voice_minutes_24h: number;
  voice_minutes_7d: number;
  voice_minutes_30d: number;
  top_users_by_voice: { user_id: string; username: string; display_name: string; minutes: number }[];
}

export interface TaggerStatus {
  loaded: boolean;
  loading: boolean;
  enabled: boolean;
}
