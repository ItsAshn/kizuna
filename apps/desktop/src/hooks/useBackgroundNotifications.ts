import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'
import type { Message, Channel } from '@kizuna/shared'
import { showNotification, ensureNotificationPermission } from '../utils/showNotification'
import { tryDecryptSocketDM, tryDecryptGroupDM } from '../utils/decryptSocketMessage'
import { isTauri, isMobileTauri } from '../utils/platform'

export function useBackgroundNotifications(): void {
  const servers = useServerStore((s) => s.servers)
  const sessions = useServerStore((s) => s.sessions)
  const activeServerId = useServerStore((s) => s.activeServerId)
  const runInBackground = useSettingsStore((s) => s.runInBackground)
  const socketsRef = useRef<Map<string, Socket>>(new Map())

  useEffect(() => {
    if (!isTauri() || isMobileTauri()) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('set_background_enabled', { enabled: runInBackground }).catch(() => {})
    })
  }, [runInBackground])

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
        socket.emit('channel:mute:sync')
        ensureNotificationPermission()
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

      socket.on('message:mention', (mention: { channel_id: string; author_username?: string; content?: string | null }) => {
        if (activeServerId === server.id) return
        const store = useChatStore.getState()
        store.setMentionCounts({
          ...store.mentionCounts,
          [mention.channel_id]: (store.mentionCounts[mention.channel_id] || 0) + 1,
        })
        showNotification({
          type: 'mention',
          title: mention.author_username || 'Someone',
          body: mention.content ? (mention.content.length > 100 ? mention.content.slice(0, 100) + '...' : mention.content) : '',
          channelId: mention.channel_id,
        })
      })

      socket.on('dm:received', (message: Message) => {
        const currentUserId = useServerStore.getState().sessions[server.id]?.user.id
        if (message.user_id === currentUserId) return
        if (activeServerId === server.id) return // useSocket.ts already handles the active server
        const decrypted = tryDecryptSocketDM(message)
        const store = useChatStore.getState()
        const sender = decrypted.display_name || decrypted.username || 'Someone'
        const body = decrypted.content.length > 100 ? decrypted.content.slice(0, 100) + '...' : decrypted.content
        showNotification({ type: 'message', title: sender, body, channelId: message.channel_id })
        store.setUnreadCounts({
          ...store.unreadCounts,
          [message.channel_id]: (store.unreadCounts[message.channel_id] || 0) + 1,
        })
      })

      socket.on('group-dm:received', (message: Message) => {
        const currentUserId = useServerStore.getState().sessions[server.id]?.user.id
        if (message.user_id === currentUserId) return
        if (activeServerId === server.id) return // useSocket.ts already handles the active server
        const decrypted = tryDecryptGroupDM(message)
        const store = useChatStore.getState()
        const sender = decrypted.display_name || decrypted.username || 'Someone'
        const body = decrypted.content.length > 100 ? decrypted.content.slice(0, 100) + '...' : decrypted.content
        showNotification({ type: 'message', title: sender, body, channelId: message.channel_id })
        store.setUnreadCounts({
          ...store.unreadCounts,
          [message.channel_id]: (store.unreadCounts[message.channel_id] || 0) + 1,
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
