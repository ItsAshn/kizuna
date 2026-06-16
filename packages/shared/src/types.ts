export interface SavedServer {
  id: string
  name: string
  url: string
  icon?: string
  addedAt: number
}

export type UserStatus = 'online' | 'idle' | 'busy' | 'offline'

export interface User {
  id: string
  username: string
  display_name: string
  avatar?: string
  banner?: string
  created_at: number
  role?: 'admin' | 'member'
  is_host?: boolean
  last_seen_at?: number | null
  public_key?: string | null
  key_salt?: string | null
  status?: UserStatus
  permissions?: Record<string, boolean>
}

export interface Channel {
  id: string
  name: string
  type: 'text' | 'voice'
  topic?: string | null
  position: number
  locked: boolean
  write_role_id?: string | null
  write_role_name?: string | null
  created_at: number
}

export interface Message {
  id: string
  channel_id: string
  user_id: string
  username?: string
  display_name?: string
  avatar?: string
  content: string
  encrypted?: number
  created_at: number
  edited_at?: number | null
  updated_at?: number | null
  reactions?: MessageReaction[]
  reply_to_message_id?: string | null
  reply_to_username?: string | null
  reply_to_content?: string | null
}

export type ReactionType = 'emoji' | 'sticker'

export interface ReactionUser {
  user_id: string
  username: string
}

export interface MessageReaction {
  reaction_key: string
  reaction_type: ReactionType
  count: number
  users: ReactionUser[]
}

export interface MessageEdit {
  id: string
  message_id: string
  old_content: string
  edited_by: string
  edited_at: number
}

export interface Member {
  id: string
  username: string
  display_name: string
  avatar?: string
  banner?: string
  role?: 'admin' | 'member'
  is_host?: boolean
  custom_roles?: CustomRole[]
  custom_role_id?: string | null
  custom_role_name?: string | null
  custom_role_color?: string | null
  hoist_role_id?: string | null
  hoist_role_name?: string | null
  hoist_role_color?: string | null
  status?: UserStatus
  reset_requested_at?: number | null
}

export interface AdminInfo {
  username: string
  display_name: string
}

export type Permission =
  | 'send_messages'
  | 'send_dm_messages'
  | 'add_reactions'
  | 'upload_attachments'
  | 'delete_messages'
  | 'manage_channels'
  | 'manage_roles'
  | 'kick_members'
  | 'manage_invites'
  | 'use_voice'
  | 'initiate_dm_calls'

export interface CustomRole {
  id: string
  name: string
  color: string
  permissions: Partial<Record<Permission, boolean>>
  is_admin?: boolean
  position?: number
  hoist?: boolean
  mentionable?: boolean
  default_on_join?: boolean
  created_at?: number
}

export type ConnectionQuality = 'good' | 'fair' | 'poor'

export interface VoicePeer {
  id: string
  userId: string
  username: string
  speaking: boolean
  muted: boolean
  connectionQuality?: ConnectionQuality
}

export interface VoicePeerFull extends VoicePeer {
  peerId: string
  userId: string
  username: string
}

export interface IceServer {
  urls: string
  username?: string
  credential?: string
}

export interface VoiceJoinResponse {
  rtpCapabilities?: any
  routerRtpCapabilities?: any
  peers?: VoicePeerFull[]
  iceServers?: IceServer[]
  error?: string
}

export interface VoiceError {
  type: 'permission_denied' | 'device_not_found' | 'device_in_use' | 'transport_failed' | 'unknown'
  message: string
}

export interface InviteCode {
  code: string
  created_by?: string
  max_uses: number | null
  uses: number
  expires_at: number | null
  created_at?: number
}

export interface ServerSession {
  serverId: string
  token: string
  user: User
}

export interface DMChannelData {
  id: string
  other_user_id: string
  other_username: string
  other_display_name: string
  other_avatar: string | null
  other_public_key: string | null
  created_at: number
  last_message_at: number | null
}

export interface FileAttachment {
  id: string
  message_id: string | null
  filename: string
  url: string
  size: number
  content_type?: string
  created_at: number
}

export interface Mention {
  id: string
  message_id: string
  channel_id: string
  author_id: string
  author_username: string
  mentioned_user_id: string | null
  mention_type: 'everyone' | 'here' | 'user' | 'role'
  content: string
  read: number
  created_at: number
}

export interface UnreadCount {
  channel_id: string
  count: number
}

export interface ScreenSharePeer {
  peerId: string
  userId: string
  username: string
}

export interface MonitorInfo {
  index: number
  name: string
  width: number
  height: number
}

export interface ServerInfo {
  name: string
  description: string
  passwordProtected: boolean
  icon: string | null
  serverUrl: string | null
  hasBackground: boolean
  backgroundBlur: number
  customCss: string | null
  voiceBitrateKbps: number
  gifsEnabled: boolean
}

export type GifType = 'gif' | 'sticker'

export interface GifInfo {
  id: string
  type: GifType
  display_name: string
  category: string
  tags: string
  pack_name: string | null
  file_url: string
  file_size: number
  width: number | null
  height: number | null
  created_at: number
}

export interface PoWChallenge {
  challenge: string
  difficulty: number
  expiresAt: number
}

export interface ChannelMute {
  channel_id: string
  muted_until: number | null
}
