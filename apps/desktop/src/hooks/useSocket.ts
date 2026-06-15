import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { decryptDM, isEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import type { Message, Channel, DMChannelData, UserStatus, MessageReaction, Member } from '@kizuna/shared'
import { showNotification } from '../utils/showNotification'

function tryDecryptSocketDM(message: Message): Message {
  if (!message.encrypted) return message
  const parsed = isEncryptedContent(message.content)
  if (!parsed) return message
  const secKey = getSecretKey()
  if (!secKey) return { ...message, content: '[Encrypted - no key available]' }
  const dm = useChatStore.getState().dmChannels.find((d) => d.id === message.channel_id)
  const otherPubKey = dm?.other_public_key
  if (!otherPubKey) return { ...message, content: '[Encrypted - missing sender key]' }
  try {
    const decrypted = decryptDM(parsed, otherPubKey, secKey)
    return { ...message, content: decrypted }
  } catch {
    return { ...message, content: '[Encrypted - unable to decrypt]' }
  }
}

export function useSocket(): MutableRefObject<Socket | null> {
  const socketRef = useRef<Socket | null>(null)
  const session = useServerStore((s) => s.activeSession)

  useEffect(() => {
    if (!session) {
      socketRef.current?.disconnect()
      socketRef.current = null
      return
    }

    const socket = io(session.url, {
      auth: { token: session.token },
      withCredentials: true,
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      useChatStore.getState().setSocketConnected(true)
      socket.emit('user:subscribe')
      socket.emit('notification:subscribe')
      socket.emit('user:joined')
      socket.emit('channel:mute:sync')
      socket.emit('voice:getOccupancy', (res: { channels: Record<string, { userId: string; username: string }[]> }) => {
        if (res?.channels) {
          useChatStore.getState().setVoiceChannelUsers(res.channels)
        }
      })
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission()
      }
    })

    socket.on('disconnect', () => {
      useChatStore.getState().setSocketConnected(false)
    })

    socket.io.on('reconnect_attempt', (attempt) => {
      useChatStore.getState().setSocketReconnecting(true)
      useChatStore.getState().setSocketReconnectAttempts(attempt)
    })

    socket.io.on('reconnect', () => {
      useChatStore.getState().setSocketReconnectAttempts(0)
    })

    socket.on('connect_error', (err) => {
      useChatStore.getState().setSocketConnected(false)
      const msg = err.message || ''
      if (msg.includes('Invalid or expired token') || msg.includes('Authentication required') || msg.includes('User not found')) {
        useServerStore.getState().setActiveSession(null)
        window.location.href = '/'
      }
    })

    socket.on('message:new', (message: Message) => {
      useChatStore.setState((state) => {
        const existing = state.messages[message.channel_id] || []
        if (existing.some((m) => m.id === message.id)) return {}

        const serverId = useServerStore.getState().activeSession?.serverId
        const notif = serverId ? state.notificationSettings[serverId] : undefined
        const skipUnread = notif?.level === 'none' || notif?.level === 'mentions'

        const newState: any = {
          messages: {
            ...state.messages,
            [message.channel_id]: [...existing, message],
          },
        }
        if (message.channel_id !== state.activeChannelId && !skipUnread) {
          newState.unreadCounts = {
            ...state.unreadCounts,
            [message.channel_id]: (state.unreadCounts[message.channel_id] || 0) + 1,
          }
        }
        return newState
      })
    })

    socket.on('message:edit', (message: Message) => {
      const store = useChatStore.getState()
      const channelMessages = store.messages[message.channel_id] || []
      const updated = channelMessages.map((m) => (m.id === message.id ? message : m))
      store.setMessages(message.channel_id, updated)
    })

    socket.on('message:delete', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeMessage(channel_id, id)
    })

    socket.on('dm:received', (message: Message) => {
      const decrypted = tryDecryptSocketDM(message)
      useChatStore.setState((state) => {
        const existing = state.messages[message.channel_id] || []
        if (existing.some((m) => m.id === message.id)) return {}
        const newState: any = {
          messages: {
            ...state.messages,
            [message.channel_id]: [...existing, decrypted],
          },
        }
        if (message.channel_id !== state.activeDMChannelId) {
          newState.unreadCounts = {
            ...state.unreadCounts,
            [message.channel_id]: (state.unreadCounts[message.channel_id] || 0) + 1,
          }
        }
        return newState
      })
    })

    socket.on('dm:edit', (message: Message) => {
      const store = useChatStore.getState()
      const decrypted = tryDecryptSocketDM(message)
      const channelMessages = store.messages[message.channel_id] || []
      const updated = channelMessages.map((m) => (m.id === message.id ? decrypted : m))
      store.setMessages(message.channel_id, updated)
    })

    socket.on('dm:delete', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeMessage(channel_id, id)
    })

    socket.on('message:mention', (mention: any) => {
      const serverId = useServerStore.getState().activeSession?.serverId
      const notif = serverId ? useChatStore.getState().notificationSettings[serverId] : undefined
      const isEveryone = mention.mention_type === 'everyone' || mention.mention_type === 'here'
      const suppress = notif?.suppressEveryone && isEveryone

      if (!suppress) {
        useChatStore.setState((state) => ({
          mentionCounts: {
            ...state.mentionCounts,
            [mention.channel_id]: (state.mentionCounts[mention.channel_id] || 0) + 1,
          },
          serverMentionCounts: {
            ...state.serverMentionCounts,
            [session!.serverId]: (state.serverMentionCounts[session!.serverId] || 0) + 1,
          },
        }))
      }
      if (mention.channel_id !== useChatStore.getState().activeChannelId) {
        showNotification({
          type: 'mention',
          title: mention.author_username || 'Someone',
          body: mention.content?.length > 100 ? mention.content.slice(0, 100) + '...' : mention.content || '',
          channelId: mention.channel_id,
        })
      }
    })

    socket.on('channel:created', (channel: Channel) => {
      const store = useChatStore.getState()
      store.setChannels([...store.channels, channel])
    })

    socket.on('channel:updated', (channel: Channel) => {
      const store = useChatStore.getState()
      store.setChannels(store.channels.map((c) => (c.id === channel.id ? channel : c)))
    })

    socket.on('channel:deleted', ({ id }: { id: string }) => {
      const store = useChatStore.getState()
      store.setChannels(store.channels.filter((c) => c.id !== id))
      if (store.activeChannelId === id) {
        store.setActiveChannel(null)
      }
      if (store.activeVoiceChannelId === id) {
        store.setActiveVoiceChannel(null)
      }
    })

    socket.on('server:announce', ({ title, body }: { title: string; body: string }) => {
      showNotification({ type: 'announce', title, body })
    })

    socket.on('channel:mute', ({ channel_id, muted_until }: { channel_id: string; muted_until: number | null }) => {
      useChatStore.getState().upsertChannelMute(channel_id, muted_until)
    })

    socket.on('channel:unmute', ({ channel_id }: { channel_id: string }) => {
      useChatStore.getState().removeChannelMute(channel_id)
    })

    socket.on('channel:mute:sync', (mutes: Record<string, number | null>) => {
      useChatStore.getState().setChannelMutes(mutes)
    })

    socket.on('typing:start', ({ channelId, username }: { channelId: string; username: string }) => {
      const store = useChatStore.getState()
      const current = store.typingUsers[channelId] || []
      if (!current.includes(username)) {
        store.setTypingUsers(channelId, [...current, username])
      }
    })

    socket.on('typing:stop', ({ channelId, username }: { channelId: string; username: string }) => {
      const store = useChatStore.getState()
      const current = store.typingUsers[channelId] || []
      store.setTypingUsers(
        channelId,
        current.filter((u: string) => u !== username),
      )
    })

    socket.on('message:react:add', ({ messageId, channelId, reaction }: { messageId: string; channelId: string; reaction: { reaction_key: string; reaction_type: string; userId: string; username: string } }) => {
      const store = useChatStore.getState()
      const msgs = store.messages[channelId] || []
      const msgIdx = msgs.findIndex(m => m.id === messageId)
      if (msgIdx === -1) return
      const msg = msgs[msgIdx]
      const currentReactions = [...(msg.reactions || [])]
      const existing = currentReactions.find(r => r.reaction_key === reaction.reaction_key && r.reaction_type === reaction.reaction_type)
      if (existing) {
        existing.count++
        if (!existing.users.some(u => u.user_id === reaction.userId)) {
          existing.users.push({ user_id: reaction.userId, username: reaction.username })
        }
      } else {
        currentReactions.push({
          reaction_key: reaction.reaction_key,
          reaction_type: reaction.reaction_type as 'emoji' | 'sticker',
          count: 1,
          users: [{ user_id: reaction.userId, username: reaction.username }],
        })
      }
      store.updateMessageReactions(channelId, messageId, currentReactions)
    })

    socket.on('message:react:remove', ({ messageId, channelId, reactionKey, userId }: { messageId: string; channelId: string; reactionKey: string; userId: string }) => {
      const store = useChatStore.getState()
      const msgs = store.messages[channelId] || []
      const msgIdx = msgs.findIndex(m => m.id === messageId)
      if (msgIdx === -1) return
      const msg = msgs[msgIdx]
      const currentReactions = (msg.reactions || [])
        .map(r => {
          if (r.reaction_key === reactionKey) {
            const filtered = r.users.filter(u => u.user_id !== userId)
            if (filtered.length === 0) return null
            return { ...r, count: filtered.length, users: filtered }
          }
          return r
        })
        .filter(Boolean) as MessageReaction[]
      store.updateMessageReactions(channelId, messageId, currentReactions)
    })

    socket.on('user:online', ({ userId, status }: { userId: string; status: UserStatus }) => {
      useChatStore.getState().setUserStatus(userId, status)
    })

    socket.on('user:offline', ({ userId }: { userId: string }) => {
      useChatStore.getState().setUserStatus(userId, 'offline')
    })

    socket.on('users:online', (onlineList: Record<string, { username: string; status: UserStatus }>) => {
      const store = useChatStore.getState()
      const statuses: Record<string, UserStatus> = {}
      for (const [uid, info] of Object.entries(onlineList)) {
        statuses[uid] = info.status
      }
      store.setUserStatuses(statuses)
    })

    socket.on('user:status', ({ userId, status }: { userId: string; status: UserStatus }) => {
      useChatStore.getState().setUserStatus(userId, status)
    })

    socket.on('member:updated', (updatedMember: Member) => {
      const store = useChatStore.getState()
      store.setMembers(store.members.map(m => m.id === updatedMember.id ? updatedMember : m))
      const serverStore = useServerStore.getState()
      if (serverStore.activeSession && updatedMember.id === serverStore.activeSession.user.id) {
        serverStore.setActiveSession({
          ...serverStore.activeSession,
          user: {
            ...serverStore.activeSession.user,
            role: updatedMember.role,
          },
        })
      }
    })

    socket.on('member:removed', ({ userId }: { userId: string }) => {
      const store = useChatStore.getState()
      store.setMembers(store.members.filter(m => m.id !== userId))
    })

    socket.on('voice:userJoinedChannel', ({ channelId, userId, username }: { channelId: string; userId: string; username: string }) => {
      useChatStore.getState().addVoiceChannelUser(channelId, { userId, username })
    })

    socket.on('voice:userLeftChannel', ({ channelId, userId }: { channelId: string; userId: string }) => {
      useChatStore.getState().removeVoiceChannelUser(channelId, userId)
    })

    const heartbeatInterval = setInterval(() => {
      if (socket.connected) {
        socket.emit('presence:heartbeat')
      }
    }, 30_000)

    return () => {
      clearInterval(heartbeatInterval)
      socket.disconnect()
      socketRef.current = null
    }
  }, [session?.serverId])

  return socketRef
}
