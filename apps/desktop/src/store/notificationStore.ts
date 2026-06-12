import { create } from 'zustand'

export interface NotificationItem {
  id: string
  type: 'announce' | 'mention' | 'message'
  title: string
  body: string
  channelId?: string
  timestamp: number
}

interface NotificationState {
  notifications: NotificationItem[]
  addNotification: (item: Omit<NotificationItem, 'id' | 'timestamp'>) => void
  dismissNotification: (id: string) => void
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  addNotification: (item) => {
    const id = crypto.randomUUID()
    const notification: NotificationItem = {
      ...item,
      id,
      timestamp: Date.now(),
    }
    set((state) => ({
      notifications: [...state.notifications, notification],
    }))
    setTimeout(() => {
      set((state) => ({
        notifications: state.notifications.filter((n) => n.id !== id),
      }))
    }, 5000)
  },
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
}))
