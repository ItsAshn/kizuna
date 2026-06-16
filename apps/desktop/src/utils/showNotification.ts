import { useNotificationStore } from '../store/notificationStore'
import { useChatStore } from '../store/chatStore'

interface ShowNotificationOptions {
  type: 'announce' | 'mention' | 'message' | 'dmcall'
  title: string
  body: string
  channelId?: string
}

export function showNotification(opts: ShowNotificationOptions) {
  if (opts.channelId && opts.type !== 'announce' && opts.type !== 'dmcall') {
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

  const tag = opts.type === 'mention' ? `mention-${opts.channelId}` :
              opts.type === 'announce' ? 'announce' :
              opts.type === 'dmcall' ? 'dmcall' :
              `message-${opts.channelId ?? 'unknown'}`

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(opts.title, { body: opts.body, icon: '/Logo.webp', tag })
    } catch { /* not supported */ }
  }
}

export function showErrorToast(context: string) {
  useNotificationStore.getState().addNotification({
    type: 'message',
    title: 'Error',
    body: `Failed to ${context}. Please try again.`,
  })
}
