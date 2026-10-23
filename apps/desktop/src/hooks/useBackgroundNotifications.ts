import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'
import type { Message } from '@kizuna/shared'
import { showNotification, ensureNotificationPermission } from '../utils/showNotification'
import { tryDecryptSocketDM, tryDecryptGroupDM } from '../utils/decryptSocketMessage'
import { isTauri, isMobileTauri } from '../utils/platform'

function truncate(text: string | null | undefined): string {
  if (!text) return ''
  return text.length > 100 ? text.slice(0, 100) + '...' : text
}

function bumpUnread(channelId: string) {
  const store = useChatStore.getState()
  store.setUnreadCounts({
    ...store.unreadCounts,
    [channelId]: (store.unreadCounts[channelId] || 0) + 1,
  })
}

/**
 * Keeps one notification-only socket open for every server the user is signed
 * in to *except* the active one. The active server already has the full socket
 * from useSocket, and a second socket there used to double-deliver messages and
 * channel events. Each socket only raises notifications and unread badges; it
 * never touches the active server's channel list or message cache.
 */
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
    const next = new Map<string, Socket>()

    for (const server of servers) {
      const session = sessions[server.id]
      if (!session || server.id === activeServerId) continue

      const existing = socketsRef.current.get(server.id)
      if (existing) {
        next.set(server.id, existing)
        continue
      }

      const serverId = server.id
      // Guards against a stale socket still delivering after this server
      // became the active one (useSocket owns it from then on).
      const isActive = () => useServerStore.getState().activeServerId === serverId
      const currentUserId = () => useServerStore.getState().sessions[serverId]?.user.id

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
        if (isActive() || message.user_id === currentUserId()) return
        showNotification({
          type: 'message',
          title: message.display_name || message.username || 'Someone',
          body: truncate(message.content),
          channelId: message.channel_id,
          serverId,
        })
        bumpUnread(message.channel_id)
      })

      socket.on(
        'message:mention',
        (mention: { channel_id: string; author_username?: string; content?: string | null }) => {
          if (isActive()) return
          const store = useChatStore.getState()
          store.setMentionCounts({
            ...store.mentionCounts,
            [mention.channel_id]: (store.mentionCounts[mention.channel_id] || 0) + 1,
          })
          store.incrementServerMentionCount(serverId)
          showNotification({
            type: 'mention',
            title: mention.author_username || 'Someone',
            body: truncate(mention.content),
            channelId: mention.channel_id,
            serverId,
          })
        },
      )

      socket.on('dm:received', (message: Message) => {
        if (isActive() || message.user_id === currentUserId()) return
        const decrypted = tryDecryptSocketDM(message)
        showNotification({
          type: 'message',
          title: decrypted.display_name || decrypted.username || 'Someone',
          body: truncate(decrypted.content),
          channelId: message.channel_id,
          serverId,
        })
        bumpUnread(message.channel_id)
      })

      socket.on('group-dm:received', (message: Message) => {
        if (isActive() || message.user_id === currentUserId()) return
        const decrypted = tryDecryptGroupDM(message)
        showNotification({
          type: 'message',
          title: decrypted.display_name || decrypted.username || 'Someone',
          body: truncate(decrypted.content),
          channelId: message.channel_id,
          serverId,
        })
        bumpUnread(message.channel_id)
      })

      socket.on('server:announce', ({ title, body }: { title: string; body: string }) => {
        if (isActive()) return
        showNotification({ type: 'announce', title, body, serverId })
      })

      socket.on(
        'channel:mute',
        ({ channel_id, muted_until }: { channel_id: string; muted_until: number | null }) => {
          useChatStore.getState().upsertChannelMute(serverId, channel_id, muted_until)
        },
      )

      socket.on('channel:unmute', ({ channel_id }: { channel_id: string }) => {
        useChatStore.getState().removeChannelMute(serverId, channel_id)
      })

      socket.on('channel:mute:sync', (mutes: Record<string, number | null>) => {
        useChatStore.getState().setChannelMutes(serverId, mutes)
      })

      next.set(serverId, socket)
    }

    // Close sockets for servers that were removed, signed out of, or have just
    // become the active server.
    for (const [id, socket] of socketsRef.current) {
      if (!next.has(id)) socket.disconnect()
    }
    socketsRef.current = next
  }, [servers, sessions, activeServerId])

  useEffect(() => {
    const sockets = socketsRef
    return () => {
      for (const [, socket] of sockets.current) socket.disconnect()
      sockets.current.clear()
    }
  }, [])
}
