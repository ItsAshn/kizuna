import type { Server, Socket } from 'socket.io'
import { registerRoomHandlers } from './chat/rooms'
import { registerChannelMessageHandlers } from './chat/channelMessages'
import { registerDmHandlers } from './chat/dms'
import { registerGroupDmHandlers } from './chat/groupDms'
import { registerCallHandlers } from './chat/calls'
import { registerPresenceHandlers } from './chat/presence'
import { registerReactionHandlers } from './chat/reactions'

export { parseMentions, processMentions } from './chat/mentions'
export { getMessageInfo, broadcastReaction } from './chat/helpers'

export function registerChatHandlers(io: Server, socket: Socket): void {
  registerRoomHandlers(io, socket)
  registerChannelMessageHandlers(io, socket)
  registerDmHandlers(io, socket)
  registerGroupDmHandlers(io, socket)
  registerCallHandlers(io, socket)
  registerPresenceHandlers(io, socket)
  registerReactionHandlers(io, socket)
}
