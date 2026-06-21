import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { useSettingsStore } from '../store/settingsStore'
import type { DMIncomingCall } from '../store/callStore'
import { decryptDM, isEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import type { Message, Channel, DMChannelData, UserStatus, MessageReaction, Member, PinnedMessage, Thread } from '@kizuna/shared'
import { refreshToken } from '@kizuna/shared'
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
      useSettingsStore.getState().setSocketConnected(true)
      socket.emit('user:subscribe')
      socket.emit('notification:subscribe')
      socket.emit('user:joined')
      socket.emit('channel:mute:sync')
      socket.emit('voice:getOccupancy', (res: { channels: Record<string, { userId: string; username: string }[]> }) => {
        if (res?.channels) {
          useVoiceStore.getState().setVoiceChannelUsers(res.channels)
        }
      })
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission()
      }
    })

    socket.on('disconnect', () => {
      useSettingsStore.getState().setSocketConnected(false)
    })

    socket.io.on('reconnect_attempt', (attempt) => {
      useSettingsStore.getState().setSocketReconnecting(true)
      useSettingsStore.getState().setSocketReconnectAttempts(attempt)
    })

    socket.io.on('reconnect', () => {
      useSettingsStore.getState().setSocketReconnectAttempts(0)
    })

    socket.on('connect_error', (err) => {
      useSettingsStore.getState().setSocketConnected(false)
      const msg = err.message || ''
      if (msg.includes('Invalid or expired token') || msg.includes('Authentication required') || msg.includes('User not found')) {
        ;(async () => {
          const session = useServerStore.getState().activeSession
          if (!session) {
            window.location.href = '/'
            return
          }
          const newToken = await refreshToken(session.url)
          if (newToken) {
            useServerStore.getState().setActiveSession({
              ...session,
              token: newToken,
            })
          } else {
            useServerStore.getState().setActiveSession(null)
            window.location.href = '/'
          }
        })()
      }
    })

    socket.on('message:new', (message: Message) => {
      useChatStore.setState((state) => {
        const existing = state.messages[message.channel_id] || []
        if (existing.some((m) => m.id === message.id)) return {}

        const serverId = useServerStore.getState().activeSession?.serverId
        const notif = serverId ? useSettingsStore.getState().notificationSettings[serverId] : undefined
        const skipUnread = notif?.level === 'none' || notif?.level === 'mentions'

        const newState: any = {
          messages: {
            ...state.messages,
            [message.channel_id]: [...existing, message],
          },
        }
        const currentUserId = useServerStore.getState().activeSession?.user.id
        if (message.channel_id !== state.activeChannelId && !skipUnread && message.user_id !== currentUserId) {
          newState.unreadCounts = {
            ...state.unreadCounts,
            [message.channel_id]: (state.unreadCounts[message.channel_id] || 0) + 1,
          }
        }
        return newState
      })
    })

    socket.on('message:edit', (message: Message) => {
      useChatStore.getState().updateMessage(message.channel_id, message.id, message)
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
        const currentUserId = useServerStore.getState().activeSession?.user.id
        if (message.channel_id !== state.activeDMChannelId && message.user_id !== currentUserId) {
          newState.unreadCounts = {
            ...state.unreadCounts,
            [message.channel_id]: (state.unreadCounts[message.channel_id] || 0) + 1,
          }
        }
        return newState
      })
    })

    socket.on('dm:edit', (message: Message) => {
      const decrypted = tryDecryptSocketDM(message)
      useChatStore.getState().updateMessage(decrypted.channel_id, decrypted.id, decrypted)
    })

    socket.on('dm:delete', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeMessage(channel_id, id)
    })

    socket.on('message:mention', (mention: any) => {
      const serverId = useServerStore.getState().activeSession?.serverId
      const notif = serverId ? useSettingsStore.getState().notificationSettings[serverId] : undefined
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
      if (useVoiceStore.getState().activeVoiceChannelId === id) {
        useVoiceStore.getState().setActiveVoiceChannel(null)
      }
    })

    socket.on('channel:reordered', ({ order }: { order: { id: string; position: number }[] }) => {
      const store = useChatStore.getState()
      const posMap = new Map(order.map((o) => [o.id, o.position]))
      const sorted = [...store.channels].sort((a, b) => {
        const pa = posMap.get(a.id) ?? a.position
        const pb = posMap.get(b.id) ?? b.position
        return pa - pb
      })
      store.setChannels(sorted)
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

    socket.on('message:pin', (pin: PinnedMessage) => {
      useChatStore.getState().addPinnedMessage(pin.channelId, pin)
    })

    socket.on('message:unpin', ({ channelId, messageId }: { channelId: string; messageId: string }) => {
      useChatStore.getState().removePinnedMessage(channelId, messageId)
    })

    socket.on('camera:peerStarted', ({ peerId }: { peerId: string }) => {
      useCallStore.getState().addCameraPeerId(peerId)
    })

    socket.on('camera:peerStopped', ({ peerId }: { peerId: string }) => {
      useCallStore.getState().removeCameraPeerId(peerId)
    })

    socket.on('thread:created', (thread: Thread) => {
      useChatStore.getState().addThread(thread.channel_id, thread)
      useChatStore.getState().setActiveThreadId(thread.id)
    })

    socket.on('thread:message:new', (message: Message) => {
      if (message.thread_id) {
        useChatStore.getState().addThreadMessage(message.thread_id, message)
      }
    })

    socket.on('thread:deleted', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeThread(channel_id, id)
    })

    socket.on('user:online', ({ userId, status }: { userId: string; status: UserStatus }) => {
      useVoiceStore.getState().setUserStatus(userId, status)
    })

    socket.on('user:offline', ({ userId }: { userId: string }) => {
      useVoiceStore.getState().setUserStatus(userId, 'offline')
    })

    socket.on('users:online', (onlineList: Record<string, { username: string; status: UserStatus }>) => {
      const store = useVoiceStore.getState()
      const statuses: Record<string, UserStatus> = {}
      for (const [uid, info] of Object.entries(onlineList)) {
        statuses[uid] = info.status
      }
      store.setUserStatuses(statuses)
    })

    socket.on('user:status', ({ userId, status }: { userId: string; status: UserStatus }) => {
      useVoiceStore.getState().setUserStatus(userId, status)
    })

    socket.on('member:added', (member: Member) => {
      const store = useChatStore.getState()
      if (!store.members.find(m => m.id === member.id)) {
        store.setMembers([...store.members, member])
      }
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
      useVoiceStore.getState().addVoiceChannelUser(channelId, { userId, username })
    })

    socket.on('voice:userLeftChannel', ({ channelId, userId }: { channelId: string; userId: string }) => {
      useVoiceStore.getState().removeVoiceChannelUser(channelId, userId)
    })

    socket.on('dm:call:incoming', (call: DMIncomingCall) => {
      useCallStore.getState().setIncomingCall(call)
      showNotification({
        type: 'dmcall',
        title: `${call.callerUsername} is calling you`,
        body: 'Click to accept or decline',
      })
    })

    socket.on('dm:call:accepted', ({ dmChannelId }: { dmChannelId: string }) => {
      const store = useCallStore.getState()
      if (store.dmCallStatus === 'ringing-outgoing' && store.dmCallChannelId === dmChannelId) {
        store.setDMCallStatus('active')
      }
    })

    socket.on('dm:call:rejected', () => {
      useCallStore.getState().clearDMCall()
    })

    socket.on('dm:call:ended', () => {
      const store = useCallStore.getState()
      if (store.dmCallStatus === 'active' || store.dmCallStatus === 'ringing-outgoing' || store.dmCallStatus === 'ringing-incoming') {
        store.setDMCallShouldCleanup(true)
      } else {
        store.clearDMCall()
      }
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
  }, [session?.serverId, session?.token])

  return socketRef
}
