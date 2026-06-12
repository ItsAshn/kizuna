import { useNotificationStore } from '../store/notificationStore'
import { useChatStore } from '../store/chatStore'

interface ShowNotificationOptions {
  type: 'announce' | 'mention' | 'message'
  title: string
  body: string
  channelId?: string
}

export function showNotification(opts: ShowNotificationOptions) {
  if (opts.channelId && opts.type !== 'announce') {
    const mutes = useChatStore.getState().channelMutes
    const mute = mutes[opts.channelId]
    if (mute !== undefined) {
      if (mute === null) return
      if (typeof mute === 'number' && mute > Date.now()) return
    }
  }

  useNotificationStore.getState().addNotification({
    type: opts.type,
    title: opts.title,
    body: opts.body,
    channelId: opts.channelId,
  })

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(opts.title, { body: opts.body, icon: '/Logo.webp' })
    } catch { /* not supported */ }
  }
}
