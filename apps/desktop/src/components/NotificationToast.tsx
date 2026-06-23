import { useCallback } from 'react'
import { X, Megaphone, AtSign, MessageCircle, Phone } from 'lucide-react'
import { useNotificationStore } from '../store/notificationStore'
import { useChatStore } from '../store/chatStore'
import type { NotificationItem } from '../store/notificationStore'

const typeIcons = {
  announce: Megaphone,
  mention: AtSign,
  message: MessageCircle,
  dmcall: Phone,
}

interface Props {
  notification: NotificationItem
}

export default function NotificationToast({ notification }: Props) {
  const dismissNotification = useNotificationStore((s) => s.dismissNotification)
  const setActiveChannel = useChatStore((s) => s.setActiveChannel)
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel)

  const Icon = typeIcons[notification.type]

  const handleClick = useCallback(() => {
    if (notification.channelId) {
      if (notification.type === 'dmcall') {
        setActiveDMChannel(notification.channelId)
      } else {
        setActiveChannel(notification.channelId)
      }
    }
    dismissNotification(notification.id)
  }, [notification.channelId, notification.id, notification.type, dismissNotification, setActiveChannel, setActiveDMChannel])

  const content = (
    <>
      <div className="notification-toast__icon">
        <Icon size={16} />
      </div>
      <div className="notification-toast__body">
        <div className="notification-toast__title">{notification.title}</div>
        <div className="notification-toast__text">{notification.body}</div>
      </div>
      <button
        className="notification-toast__close"
        onClick={(e) => { e.stopPropagation(); dismissNotification(notification.id) }}
      >
        <X size={12} />
      </button>
    </>
  )

  if (notification.channelId) {
    return (
      <button
        className="notification-toast notification-toast--clickable"
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick() }}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="notification-toast">
      {content}
    </div>
  )
}
