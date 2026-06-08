import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { decryptDM, isEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import type { Message, Channel, DMChannelData } from '@kizuna/shared'

export function useSocket(): MutableRefObject<Socket | null> {
  const socketRef = useRef<Socket | null>(null)
  const session = useServerStore((s) => s.activeSession)
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    if (!session) {
      socketRef.current?.disconnect()
      socketRef.current = null
      return
    }

    const socket = io(session.url, {
      auth: { token: session.token },
      transports: ['websocket', 'polling'],
    })

    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit('user:subscribe')
      socket.emit('notification:subscribe')
      socket.emit('user:joined')
    })

    socket.on('message:new', (message: Message) => {
      const store = useChatStore.getState()
      store.addMessage(message.channel_id, message)
      if (message.channel_id !== store.activeChannelId) {
        store.setUnreadCounts({
          ...store.unreadCounts,
          [message.channel_id]: (store.unreadCounts[message.channel_id] || 0) + 1,
        })
      }
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
      const store = useChatStore.getState()
      let decrypted = message
      if (message.encrypted) {
        const parsed = isEncryptedContent(message.content)
        if (parsed) {
          const secKey = getSecretKey()
          if (secKey) {
            const dm = store.dmChannels.find((d: DMChannelData) => d.id === message.channel_id)
            const otherPubKey = dm?.other_public_key
            if (otherPubKey) {
              try {
                decrypted = { ...message, content: decryptDM(parsed, otherPubKey, secKey) }
              } catch { /* leave as-is on failure */ }
            }
          }
        }
      }
      store.addMessage(message.channel_id, decrypted)
      if (message.channel_id !== store.activeDMChannelId) {
        store.setUnreadCounts({
          ...store.unreadCounts,
          [message.channel_id]: (store.unreadCounts[message.channel_id] || 0) + 1,
        })
      }
    })

    socket.on('message:mention', (mention: any) => {
      const store = useChatStore.getState()
      store.setMentionCounts({
        ...store.mentionCounts,
        [mention.channel_id]: (store.mentionCounts[mention.channel_id] || 0) + 1,
      })
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
      // Announcement received — could show a toast/notification
    })

    socket.on('typing:start', ({ username }: { username: string }) => {
      const store = useChatStore.getState()
      const channelId = store.activeChannelId || store.activeDMChannelId || ''
      const current = store.typingUsers[channelId] || []
      if (!current.includes(username)) {
        store.setTypingUsers(channelId, [...current, username])
      }
    })

    socket.on('typing:stop', ({ username }: { username: string }) => {
      const store = useChatStore.getState()
      const channelId = store.activeChannelId || store.activeDMChannelId || ''
      const current = store.typingUsers[channelId] || []
      store.setTypingUsers(
        channelId,
        current.filter((u: string) => u !== username),
      )
    })

    socket.on('user:online', ({ userId }: { userId: string }) => {
      // Could set online status in member list
    })

    socket.on('user:offline', ({ userId }: { userId: string }) => {
      // Could set offline status in member list
    })

    return () => {
      typingTimers.current.forEach((t) => clearTimeout(t))
      typingTimers.current.clear()
      socket.disconnect()
      socketRef.current = null
    }
  }, [session?.serverId, session?.token])

  return socketRef
}
