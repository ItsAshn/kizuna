import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import type { Message, Channel } from '@kizuna/shared'

export function useBackgroundNotifications(): void {
  const servers = useServerStore((s) => s.servers)
  const sessions = useServerStore((s) => s.sessions)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const socketsRef = useRef<Map<string, Socket>>(new Map())

  useEffect(() => {
    const newSockets = new Map<string, Socket>()

    for (const server of servers) {
      const session = sessions[server.id]
      if (!session?.token) continue

      const existing = socketsRef.current.get(server.id)
      if (existing) {
        newSockets.set(server.id, existing)
        continue
      }

      const socket = io(session.url, {
        auth: { token: session.token },
        transports: ['websocket', 'polling'],
      })

      socket.on('connect', () => {
        socket.emit('user:subscribe', { userId: session.user.id })
        socket.emit('notification:subscribe')
      })

      socket.on('message:new', (message: Message) => {
        const store = useChatStore.getState()
        if (activeServerId === server.id) {
          store.addMessage(message.channel_id, message)
        }
        if (document.visibilityState === 'hidden' || activeServerId !== server.id) {
          tryShowNotification(message)
        }
      })

      socket.on('message:mention', (mention: any) => {
        const store = useChatStore.getState()
        store.setMentionCounts({
          ...store.mentionCounts,
          [mention.channel_id]: (store.mentionCounts[mention.channel_id] || 0) + 1,
        })
      })

      socket.on('server:announce', ({ title, body }: { title: string; body: string }) => {
        if (document.visibilityState === 'hidden') {
          try { new Notification(title, { body, icon: '/Logo.webp' }) } catch { /* not supported */ }
        }
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
      // Don't disconnect on cleanup — leave persistent sockets alive
    }
  }, [servers, sessions, activeServerId])
}

function tryShowNotification(message: Message) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const title = `${message.display_name || message.username || 'Someone'}`
    const body = message.content.length > 100 ? message.content.slice(0, 100) + '...' : message.content
    new Notification(title, { body, icon: '/Logo.webp' })
  } catch { /* not supported */ }
}
