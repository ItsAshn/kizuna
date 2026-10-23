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
import type {
  Message,
  Channel,
  GroupDMChannelData,
  UserStatus,
  UserActivity,
  MessageReaction,
  Member,
  PinnedMessage,
  Thread,
  PollData,
} from '@kizuna/shared'
import { refreshToken } from '@kizuna/shared'
import { showNotification, ensureNotificationPermission } from '../utils/showNotification'
import { tryDecryptSocketDM, tryDecryptGroupDM } from '../utils/decryptSocketMessage'

function truncate(text: string | null | undefined): string {
  if (!text) return ''
  return text.length > 100 ? text.slice(0, 100) + '...' : text
}

/** Whether a message will also arrive as a message:mention for this user. */
function mentionsUser(content: string | null | undefined, username: string | undefined): boolean {
  if (!content) return false
  if (/(^|\s)@(everyone|here)\b/.test(content)) return true
  if (!username) return false
  return content.toLowerCase().includes(`@${username.toLowerCase()}`)
}

/** Ask the server for unread and mention counts. Sent on every (re)connect,
 * since anything that arrived while the socket was down was never counted. */
function requestUnreadState(socket: Socket) {
  socket.emit('channel:unread', (counts: Record<string, number> | null) => {
    if (!counts || typeof counts !== 'object') return
    useChatStore.setState((state) => {
      // The server only reports server text channels. DM/group-DM counts are
      // kept, and every server channel not in the reply is read.
      const serverChannelIds = new Set(state.channels.map((c) => c.id))
      const next: Record<string, number> = {}
      for (const [id, n] of Object.entries(state.unreadCounts)) {
        if (!serverChannelIds.has(id) && !(id in counts)) next[id] = n
      }
      for (const [id, n] of Object.entries(counts)) {
        if (id !== state.activeChannelId) next[id] = n
      }
      return { unreadCounts: next }
    })
  })
  socket.emit('mentions:unread', (rows: { channel_id: string; count: number }[] | null) => {
    if (!Array.isArray(rows)) return
    useChatStore.setState((state) => {
      const next: Record<string, number> = {}
      for (const r of rows) {
        if (r.channel_id !== state.activeChannelId && r.count > 0) next[r.channel_id] = r.count
      }
      return { mentionCounts: next }
    })
  })
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
    let hasConnected = false

    socket.on('connect', () => {
      useSettingsStore.getState().setSocketConnected(true)
      socket.emit('user:subscribe')
      socket.emit('user:joined')
      socket.emit('channel:mute:sync')
      socket.emit(
        'voice:getOccupancy',
        (res: { channels: Record<string, { userId: string; username: string }[]> }) => {
          if (res?.channels) {
            useVoiceStore.getState().setVoiceChannelUsers(res.channels)
          }
        },
      )
      requestUnreadState(socket)
      if (hasConnected) {
        // A reconnect is a new server-side socket with no room memberships.
        // Views that hold rooms (the open conversation, the open thread)
        // rejoin and refetch what they missed off this nonce.
        useSettingsStore.getState().bumpSocketReconnectNonce()
      }
      hasConnected = true
      ensureNotificationPermission()
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
      // Only marks the socket down; the retry state (reconnecting + attempt
      // count) is left for reconnect_attempt to advance.
      useSettingsStore.getState().setSocketConnected(false)
      const msg = err.message || ''
      if (
        msg.includes('Invalid or expired token') ||
        msg.includes('Authentication required') ||
        msg.includes('User not found')
      ) {
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
            // Refresh failed, so the session is genuinely dead — drop it
            // instead of leaving a stale entry that shows as "connected".
            useServerStore.getState().clearSession(session.serverId)
            window.location.href = '/'
          }
        })()
      }
    })

    socket.on('message:new', (message: Message) => {
      const before = useChatStore.getState()
      if ((before.messages[message.channel_id] || []).some((m) => m.id === message.id)) return
      before.addMessage(message.channel_id, message)

      const currentUser = useServerStore.getState().activeSession?.user
      if (message.channel_id === before.activeChannelId || message.user_id === currentUser?.id) {
        return
      }

      const serverId = useServerStore.getState().activeSession?.serverId
      const notif = serverId
        ? useSettingsStore.getState().notificationSettings[serverId]
        : undefined
      const skipUnread = notif?.level === 'none' || notif?.level === 'mentions'
      if (!skipUnread) {
        useChatStore.setState((state) => ({
          unreadCounts: {
            ...state.unreadCounts,
            [message.channel_id]: (state.unreadCounts[message.channel_id] || 0) + 1,
          },
        }))
      }

      // "All messages" notifies for other channels on this server too, not
      // only for background servers. showNotification applies the level,
      // per-channel overrides and mutes. A message that mentions us is left
      // to the message:mention handler so it doesn't notify twice.
      if (!mentionsUser(message.content, currentUser?.username)) {
        showNotification({
          type: 'message',
          title: message.display_name || message.username || 'Someone',
          body: truncate(message.content),
          channelId: message.channel_id,
        })
      }
    })

    socket.on('message:edit', (message: Message) => {
      useChatStore.getState().updateMessage(message.channel_id, message.id, message)
      if (message.thread_id) useChatStore.getState().updateThreadMessage(message.id, message)
    })

    socket.on('message:delete', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeMessage(channel_id, id)
      useChatStore.getState().removeThreadMessage(id)
    })

    socket.on('dm:received', (message: Message) => {
      const decrypted = tryDecryptSocketDM(message)
      useChatStore.setState((state) => {
        const existing = state.messages[message.channel_id] || []
        if (existing.some((m) => m.id === message.id)) return {}
        const newState: Record<string, unknown> = {
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

      if (message.channel_id !== useChatStore.getState().activeDMChannelId) {
        showNotification({
          type: 'message',
          title: decrypted.display_name || decrypted.username || 'Someone',
          body:
            decrypted.content.length > 100
              ? decrypted.content.slice(0, 100) + '...'
              : decrypted.content,
          channelId: message.channel_id,
        })
      }
    })

    socket.on('dm:edit', (message: Message) => {
      const decrypted = tryDecryptSocketDM(message)
      useChatStore.getState().updateMessage(decrypted.channel_id, decrypted.id, decrypted)
    })

    socket.on('dm:delete', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeMessage(channel_id, id)
    })

    socket.on('group-dm:received', (message: Message) => {
      const decrypted = tryDecryptGroupDM(message)
      useChatStore.setState((state) => {
        const existing = state.messages[message.channel_id] || []
        if (existing.some((m) => m.id === message.id)) return {}
        const newState: Record<string, unknown> = {
          messages: {
            ...state.messages,
            [message.channel_id]: [...existing, decrypted],
          },
        }
        const currentUserId = useServerStore.getState().activeSession?.user.id
        if (
          message.channel_id !== state.activeGroupDMChannelId &&
          message.user_id !== currentUserId
        ) {
          newState.unreadCounts = {
            ...state.unreadCounts,
            [message.channel_id]: (state.unreadCounts[message.channel_id] || 0) + 1,
          }
        }
        return newState
      })

      const serverId = useServerStore.getState().activeSession?.serverId
      if (serverId) {
        if (message.channel_id !== useChatStore.getState().activeGroupDMChannelId) {
          showNotification({
            type: 'message',
            title: decrypted.username || 'Group DM',
            body:
              decrypted.content?.length > 100
                ? decrypted.content.slice(0, 100) + '...'
                : decrypted.content || '',
            channelId: message.channel_id,
          })
        }
      }
    })

    socket.on('group-dm:edit', (message: Message) => {
      const decrypted = tryDecryptGroupDM(message)
      useChatStore.getState().updateMessage(decrypted.channel_id, decrypted.id, decrypted)
    })

    socket.on('group-dm:delete', ({ id, channel_id }: { id: string; channel_id: string }) => {
      useChatStore.getState().removeMessage(channel_id, id)
    })

    socket.on('group-dm:channel-created', (channel: GroupDMChannelData) => {
      const store = useChatStore.getState()
      store.setGroupDMChannels([...store.groupDMChannels, channel])
    })

    socket.on('group-dm:channel-updated', (channel: GroupDMChannelData) => {
      const store = useChatStore.getState()
      store.setGroupDMChannels(
        store.groupDMChannels.map((c) => (c.id === channel.id ? channel : c)),
      )
    })

    socket.on('group-dm:channel-deleted', ({ channel_id }: { channel_id: string }) => {
      const store = useChatStore.getState()
      store.setGroupDMChannels(store.groupDMChannels.filter((c) => c.id !== channel_id))
      const msgs = { ...store.messages }
      delete msgs[channel_id]
      useChatStore.setState({ messages: msgs })
      if (store.activeGroupDMChannelId === channel_id) {
        store.setActiveGroupDMChannel(null)
      }
    })

    socket.on(
      'group-dm:member-left',
      ({ channel_id, user_id }: { channel_id: string; user_id: string }) => {
        const store = useChatStore.getState()
        const channel = store.groupDMChannels.find((c) => c.id === channel_id)
        if (channel) {
          store.setGroupDMChannels(
            store.groupDMChannels.map((c) =>
              c.id === channel_id
                ? { ...c, members: c.members.filter((m) => m.user_id !== user_id) }
                : c,
            ),
          )
        }
      },
    )

    socket.on('group-dm:member-removed', ({ channel_id }: { channel_id: string }) => {
      const store = useChatStore.getState()
      store.setGroupDMChannels(store.groupDMChannels.filter((c) => c.id !== channel_id))
      const msgs = { ...store.messages }
      delete msgs[channel_id]
      useChatStore.setState({ messages: msgs })
      if (store.activeGroupDMChannelId === channel_id) {
        store.setActiveGroupDMChannel(null)
      }
    })

    socket.on(
      'message:mention',
      (mention: {
        channel_id: string
        author_username?: string
        content?: string | null
        mention_type?: string
      }) => {
        const serverId = useServerStore.getState().activeSession?.serverId
        const notif = serverId
          ? useSettingsStore.getState().notificationSettings[serverId]
          : undefined
        const isEveryone = mention.mention_type === 'everyone' || mention.mention_type === 'here'
        const suppress = notif?.suppressEveryone && isEveryone

        // The open channel is being read right now; badging it would leave a
        // count that only clears on the next visit.
        const isActiveChannel = mention.channel_id === useChatStore.getState().activeChannelId
        if (!suppress && !isActiveChannel) {
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
        if (!isActiveChannel) {
          showNotification({
            type: 'mention',
            title: mention.author_username || 'Someone',
            body: mention.content
              ? mention.content.length > 100
                ? mention.content.slice(0, 100) + '...'
                : mention.content
              : '',
            channelId: mention.channel_id,
          })
        }
      },
    )

    socket.on('channel:created', (channel: Channel) => {
      const store = useChatStore.getState()
      if (store.channels.some((c) => c.id === channel.id)) return
      store.setChannels([...store.channels, channel])
    })

    socket.on('channel:updated', (channel: Channel) => {
      // Permission-override changes only carry the id; there is nothing to merge.
      if (!channel?.name) return
      const store = useChatStore.getState()
      // Upsert: a channel that just became visible to us is new to this client.
      const exists = store.channels.some((c) => c.id === channel.id)
      store.setChannels(
        exists
          ? store.channels.map((c) => (c.id === channel.id ? channel : c))
          : [...store.channels, channel],
      )
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

    socket.on(
      'channel:mute',
      ({ channel_id, muted_until }: { channel_id: string; muted_until: number | null }) => {
        useChatStore.getState().upsertChannelMute(session.serverId, channel_id, muted_until)
      },
    )

    socket.on('channel:unmute', ({ channel_id }: { channel_id: string }) => {
      useChatStore.getState().removeChannelMute(session.serverId, channel_id)
    })

    socket.on('channel:mute:sync', (mutes: Record<string, number | null>) => {
      useChatStore.getState().setChannelMutes(session.serverId, mutes)
    })

    socket.on(
      'typing:start',
      ({ channelId, username }: { channelId: string; username: string }) => {
        const store = useChatStore.getState()
        const current = store.typingUsers[channelId] || []
        if (!current.includes(username)) {
          store.setTypingUsers(channelId, [...current, username])
        }
      },
    )

    socket.on('typing:stop', ({ channelId, username }: { channelId: string; username: string }) => {
      const store = useChatStore.getState()
      const current = store.typingUsers[channelId] || []
      store.setTypingUsers(
        channelId,
        current.filter((u: string) => u !== username),
      )
    })

    socket.on(
      'message:react:add',
      ({
        messageId,
        channelId,
        reaction,
      }: {
        messageId: string
        channelId: string
        reaction: { reaction_key: string; reaction_type: string; userId: string; username: string }
      }) => {
        const store = useChatStore.getState()
        const msgs = store.messages[channelId] || []
        const msgIdx = msgs.findIndex((m) => m.id === messageId)
        if (msgIdx === -1) return
        const msg = msgs[msgIdx]
        // Build new objects rather than mutating the stored reaction: the old
        // in-place count++ changed state React had already rendered, and a
        // duplicate event (our own optimistic add + the broadcast, or a
        // reconnect replay) counted the same user twice.
        const currentReactions = [...(msg.reactions || [])]
        const idx = currentReactions.findIndex(
          (r) =>
            r.reaction_key === reaction.reaction_key && r.reaction_type === reaction.reaction_type,
        )
        if (idx !== -1) {
          const existing = currentReactions[idx]
          if (existing.users.some((u) => u.user_id === reaction.userId)) return
          const users = [
            ...existing.users,
            { user_id: reaction.userId, username: reaction.username },
          ]
          currentReactions[idx] = { ...existing, users, count: users.length }
        } else {
          currentReactions.push({
            reaction_key: reaction.reaction_key,
            reaction_type: reaction.reaction_type as 'emoji' | 'sticker',
            count: 1,
            users: [{ user_id: reaction.userId, username: reaction.username }],
          })
        }
        store.updateMessageReactions(channelId, messageId, currentReactions)
      },
    )

    socket.on(
      'message:react:remove',
      ({
        messageId,
        channelId,
        reactionKey,
        userId,
      }: {
        messageId: string
        channelId: string
        reactionKey: string
        userId: string
      }) => {
        const store = useChatStore.getState()
        const msgs = store.messages[channelId] || []
        const msgIdx = msgs.findIndex((m) => m.id === messageId)
        if (msgIdx === -1) return
        const msg = msgs[msgIdx]
        const currentReactions = (msg.reactions || [])
          .map((r) => {
            if (r.reaction_key === reactionKey) {
              const filtered = r.users.filter((u) => u.user_id !== userId)
              if (filtered.length === 0) return null
              return { ...r, count: filtered.length, users: filtered }
            }
            return r
          })
          .filter(Boolean) as MessageReaction[]
        store.updateMessageReactions(channelId, messageId, currentReactions)
      },
    )

    socket.on('message:pin', (pin: PinnedMessage) => {
      useChatStore.getState().addPinnedMessage(pin.channelId, pin)
    })

    socket.on(
      'message:unpin',
      ({ channelId, messageId }: { channelId: string; messageId: string }) => {
        useChatStore.getState().removePinnedMessage(channelId, messageId)
      },
    )

    socket.on('thread:created', (thread: Thread) => {
      const store = useChatStore.getState()
      store.addThread(thread.channel_id, thread)
      // Everyone in the channel receives this; only the creator should have
      // the new thread pop open (and only if they're still in that channel).
      const me = useServerStore.getState().activeSession?.user.id
      if (thread.creator_id === me && store.activeChannelId === thread.channel_id) {
        store.setActiveThreadId(thread.id)
      }
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

    socket.on(
      'users:online',
      (
        onlineList: Record<
          string,
          { username: string; status: UserStatus; activity?: UserActivity | null }
        >,
      ) => {
        const store = useVoiceStore.getState()
        const statuses: Record<string, UserStatus> = {}
        const activities: Record<string, UserActivity> = {}
        for (const [uid, info] of Object.entries(onlineList)) {
          statuses[uid] = info.status
          if (info.activity) {
            activities[uid] = info.activity
          }
        }
        store.setUserStatuses(statuses)
        store.setUserActivities(activities)
      },
    )

    socket.on(
      'user:status',
      ({
        userId,
        status,
        status_text,
        status_emoji,
        status_sticker_id,
        activity,
      }: {
        userId: string
        status?: UserStatus
        status_text?: string | null
        status_emoji?: string | null
        status_sticker_id?: string | null
        activity?: UserActivity | null
      }) => {
        if (status !== undefined) {
          useVoiceStore.getState().setUserStatus(userId, status)
        }
        if (activity !== undefined) {
          useVoiceStore.getState().setUserActivity(userId, activity)
        }
        const serverStore = useServerStore.getState()
        if (serverStore.activeSession && userId === serverStore.activeSession.user.id) {
          const sessionUser = { ...serverStore.activeSession.user }
          let changed = false
          if (status_text !== undefined) {
            sessionUser.status_text = status_text
            changed = true
          }
          if (status_emoji !== undefined) {
            sessionUser.status_emoji = status_emoji
            changed = true
          }
          if (status_sticker_id !== undefined) {
            sessionUser.status_sticker_id = status_sticker_id
            changed = true
          }
          if (changed) {
            serverStore.setActiveSession({ ...serverStore.activeSession, user: sessionUser })
          }
        }
        if (
          status_text !== undefined ||
          status_emoji !== undefined ||
          status_sticker_id !== undefined
        ) {
          const chatStore = useChatStore.getState()
          const memberIdx = chatStore.members.findIndex((m) => m.id === userId)
          if (memberIdx !== -1) {
            const member = { ...chatStore.members[memberIdx] }
            if (status_text !== undefined) member.status_text = status_text
            if (status_emoji !== undefined) member.status_emoji = status_emoji
            if (status_sticker_id !== undefined) member.status_sticker_id = status_sticker_id
            const updated = [...chatStore.members]
            updated[memberIdx] = member
            chatStore.setMembers(updated)
          }
        }
      },
    )

    socket.on(
      'user:activity',
      ({ userId, activity }: { userId: string; activity: UserActivity | null }) => {
        useVoiceStore.getState().setUserActivity(userId, activity)
      },
    )

    socket.on('member:added', (member: Member) => {
      const store = useChatStore.getState()
      if (!store.members.find((m) => m.id === member.id)) {
        store.setMembers([...store.members, member])
      }
    })

    socket.on('member:updated', (updatedMember: Member) => {
      const store = useChatStore.getState()
      store.setMembers(store.members.map((m) => (m.id === updatedMember.id ? updatedMember : m)))
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
      store.setMembers(store.members.filter((m) => m.id !== userId))
    })

    // We're the one who got kicked/banned — the server has already revoked our
    // token, so drop the session instead of reconnect-looping against it.
    socket.on('server:removed', ({ reason }: { reason: 'kicked' | 'banned' }) => {
      showNotification({
        type: 'announce',
        title: reason === 'banned' ? 'You were banned' : 'You were kicked',
        body: 'You are no longer a member of this server.',
      })
      socket.disconnect()
      useServerStore.getState().clearSession(session.serverId)
      window.location.href = '/'
    })

    socket.on(
      'voice:userJoinedChannel',
      ({
        channelId,
        userId,
        username,
      }: {
        channelId: string
        userId: string
        username: string
      }) => {
        useVoiceStore.getState().addVoiceChannelUser(channelId, { userId, username })
      },
    )

    socket.on(
      'voice:userLeftChannel',
      ({ channelId, userId }: { channelId: string; userId: string }) => {
        useVoiceStore.getState().removeVoiceChannelUser(channelId, userId)
      },
    )

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
      if (
        store.dmCallStatus === 'active' ||
        store.dmCallStatus === 'ringing-outgoing' ||
        store.dmCallStatus === 'ringing-incoming'
      ) {
        store.setDMCallShouldCleanup(true)
      } else {
        store.clearDMCall()
      }
    })

    socket.on(
      'poll:update',
      (data: {
        pollId: string
        options: { id: string; label: string; position: number; vote_count: number }[]
        totalVotes: number
      }) => {
        useChatStore.getState().updatePoll(data.pollId, data.options)
      },
    )

    socket.on('poll:created', (data: PollData) => {
      useChatStore.getState().addPoll(data.channelId, data)
    })

    socket.on(
      'poll:deleted',
      (data: { pollId: string; channelId: string; channelType: string }) => {
        useChatStore.getState().removePoll(data.channelId, data.pollId)
      },
    )

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
