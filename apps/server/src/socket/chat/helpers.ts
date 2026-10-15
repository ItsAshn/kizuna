import type { Server, Socket } from 'socket.io'
import { getDb } from '../../db'
import { canViewChannel } from '../../middleware/auth'
import { isId, isReservedRoom } from '../validate'

export function getSocketUserId(socket: Socket): string {
  return socket.data.userId || ''
}

export function getSocketUsername(socket: Socket): string {
  return socket.data.username || 'unknown'
}

export function getMessageInfo(
  db: ReturnType<typeof getDb>,
  messageId: string,
): {
  channel_id: string
  isDM: boolean
  isGroupDM?: boolean
  participants?: { user1_id: string; user2_id: string }
  groupMembers?: string[]
} | null {
  const msg = db.prepare('SELECT channel_id FROM messages WHERE id = ?').get(messageId) as
    | { channel_id: string }
    | undefined
  if (msg) return { channel_id: msg.channel_id, isDM: false }

  const dm = db
    .prepare(
      `SELECT dm.channel_id, dc.user1_id, dc.user2_id
       FROM direct_messages dm
       JOIN dm_channels dc ON dc.id = dm.channel_id
       WHERE dm.id = ?`,
    )
    .get(messageId) as { channel_id: string; user1_id: string; user2_id: string } | undefined
  if (dm)
    return {
      channel_id: dm.channel_id,
      isDM: true,
      participants: { user1_id: dm.user1_id, user2_id: dm.user2_id },
    }

  const gdm = db
    .prepare(
      `SELECT gdm.channel_id
       FROM group_dm_messages gdm
       WHERE gdm.id = ?`,
    )
    .get(messageId) as { channel_id: string } | undefined
  if (gdm) {
    const gm = db
      .prepare('SELECT user_id FROM group_dm_members WHERE channel_id = ?')
      .all(gdm.channel_id) as { user_id: string }[]
    return {
      channel_id: gdm.channel_id,
      isDM: false,
      isGroupDM: true,
      groupMembers: gm.map((r) => r.user_id),
    }
  }

  return null
}

export function broadcastReaction(
  io: Server,
  msgInfo: {
    channel_id: string
    isDM: boolean
    isGroupDM?: boolean
    participants?: { user1_id: string; user2_id: string }
    groupMembers?: string[]
  },
  event: string,
  payload: unknown,
) {
  if (msgInfo.isDM && msgInfo.participants) {
    io.to(`dm:${msgInfo.participants.user1_id}`).emit(event, payload)
    io.to(`dm:${msgInfo.participants.user2_id}`).emit(event, payload)
  } else if (msgInfo.isGroupDM && msgInfo.groupMembers) {
    for (const userId of msgInfo.groupMembers) {
      io.to(`group-dm:${userId}`).emit(event, payload)
    }
  } else {
    io.to(msgInfo.channel_id).emit(event, payload)
  }
}

export type RoomKind = 'channel' | 'dm' | 'group-dm'

// Resolves a client-supplied room id to something the user may actually be
// in: a server channel they can view, a DM they are a party to, or a group DM
// they belong to. Anything else (unknown ids, personal user:/dm:/group-dm:
// rooms, other people's conversations) yields null.
export function resolveAccessibleRoom(
  userId: string,
  roomId: unknown,
): { kind: RoomKind; type?: string } | null {
  if (!userId || !isId(roomId) || isReservedRoom(roomId)) return null
  const db = getDb()
  const channel = db.prepare('SELECT type FROM channels WHERE id = ?').get(roomId) as
    | { type: string }
    | undefined
  if (channel) {
    return canViewChannel(userId, roomId) ? { kind: 'channel', type: channel.type } : null
  }
  const dm = db
    .prepare('SELECT 1 FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)')
    .get(roomId, userId, userId)
  if (dm) return { kind: 'dm' }
  const gdm = db
    .prepare('SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?')
    .get(roomId, userId)
  if (gdm) return { kind: 'group-dm' }
  return null
}

type MessageInfo = NonNullable<ReturnType<typeof getMessageInfo>>

// Whether the user may see (and therefore react to) a message resolved by
// getMessageInfo: a server channel they can view, a DM they are a party to,
// or a group DM they belong to.
export function canAccessMessage(userId: string, info: MessageInfo): boolean {
  if (info.isDM) {
    return (
      !!info.participants &&
      (info.participants.user1_id === userId || info.participants.user2_id === userId)
    )
  }
  if (info.isGroupDM) return !!info.groupMembers?.includes(userId)
  return canViewChannel(userId, info.channel_id)
}

export function isDmParticipant(userId: string, dmChannelId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)')
    .get(dmChannelId, userId, userId)
}

export function isGroupDmMember(userId: string, channelId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId)
}
