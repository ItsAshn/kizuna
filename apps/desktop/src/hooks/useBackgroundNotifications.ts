import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import type { Message, Channel } from '@kizuna/shared'
import { showNotification } from '../utils/showNotification'

export function useBackgroundNotifications(): void {
  const servers = useServerStore((s) => s.servers)
  const sessions = useServerStore((s) => s.sessions)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const socketsRef = useRef<Map<string, Socket>>(new Map())

  useEffect(() => {
    const newSockets = new Map<string, Socket>()

    for (const server of servers) {
      const session = sessions[server.id]
      if (!session) continue

      const existing = socketsRef.current.get(server.id)
      if (existing) {
        newSockets.set(server.id, existing)
        continue
      }

      const socket = io(session.url, {
        withCredentials: true,
        transports: ['websocket', 'polling'],
      })

      socket.on('connect', () => {
        socket.emit('user:subscribe')
        socket.emit('notification:subscribe')
        socket.emit('channel:mute:sync')
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission()
        }
      })

      socket.on('message:new', (message: Message) => {
        const store = useChatStore.getState()
        const currentUserId = useServerStore.getState().sessions[server.id]?.user.id
        if (message.user_id === currentUserId) return
        if (activeServerId === server.id) {
          store.addMessage(message.channel_id, message)
        }
        if (activeServerId !== server.id || message.channel_id !== store.activeChannelId) {
          if (activeServerId === server.id) return
          const sender = message.display_name || message.username || 'Someone'
          const body = message.content.length > 100 ? message.content.slice(0, 100) + '...' : message.content
          showNotification({ type: 'message', title: sender, body, channelId: message.channel_id })
          store.setUnreadCounts({
            ...store.unreadCounts,
            [message.channel_id]: (store.unreadCounts[message.channel_id] || 0) + 1,
          })
        }
      })

      socket.on('message:mention', (mention: any) => {
        if (activeServerId === server.id) return
        const store = useChatStore.getState()
        store.setMentionCounts({
          ...store.mentionCounts,
          [mention.channel_id]: (store.mentionCounts[mention.channel_id] || 0) + 1,
        })
        showNotification({
          type: 'mention',
          title: mention.author_username || 'Someone',
          body: mention.content?.length > 100 ? mention.content.slice(0, 100) + '...' : mention.content || '',
          channelId: mention.channel_id,
        })
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

      socket.on('channel:created', (channel: Channel) => {
        const store = useChatStore.getState()
        if (activeServerId === server.id) {
          store.setChannels([...store.channels, channel])
        }
      })

      socket.on('channel:deleted', ({ id }: { id: string }) => {
        const store = useChatStore.getState()
        if (activeServerId === server.id) {
          store.setChannels(store.channels.filter((c) => c.id !== id))
        }
      })

      newSockets.set(server.id, socket)
    }

    for (const [id, socket] of socketsRef.current) {
      if (!newSockets.has(id)) {
        socket.disconnect()
      }
    }

    socketsRef.current = newSockets

    return () => {
      const current = socketsRef.current
      for (const [, socket] of current) {
        socket.disconnect()
      }
      current.clear()
    }
  }, [servers, sessions, activeServerId])
}
