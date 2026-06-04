export interface SavedServer {
  id: string
  name: string
  url: string
  icon?: string
  addedAt: number
}

export interface User {
  id: string
  username: string
  display_name: string
  avatar?: string
  created_at: number
  role?: 'admin' | 'member'
  last_seen_at?: number | null
}

export interface Channel {
  id: string
  name: string
  type: 'text' | 'voice'
  topic?: string | null
  position: number
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
  created_at: number
  edited_at?: number | null
  updated_at?: number | null
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
  role?: 'admin' | 'member'
  custom_role_id?: string | null
  custom_role_name?: string | null
  custom_role_color?: string | null
}

export type Permission =
  | 'send_messages'
  | 'manage_channels'
  | 'delete_messages'
  | 'kick_members'
  | 'manage_invites'

export interface CustomRole {
  id: string
  name: string
  color: string
  permissions: Partial<Record<Permission, boolean>>
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
  mention_type: 'everyone' | 'here' | 'user'
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
