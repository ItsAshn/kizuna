import { useCallback } from 'react'
import { X, Megaphone, AtSign, MessageCircle } from 'lucide-react'
import { useNotificationStore } from '../store/notificationStore'
import { useChatStore } from '../store/chatStore'
import type { NotificationItem } from '../store/notificationStore'

const typeIcons = {
  announce: Megaphone,
  mention: AtSign,
  message: MessageCircle,
}

interface Props {
  notification: NotificationItem
}

export default function NotificationToast({ notification }: Props) {
  const dismissNotification = useNotificationStore((s) => s.dismissNotification)
  const setActiveChannel = useChatStore((s) => s.setActiveChannel)

  const Icon = typeIcons[notification.type]

  const handleClick = useCallback(() => {
    if (notification.channelId) {
      setActiveChannel(notification.channelId)
    }
    dismissNotification(notification.id)
  }, [notification.channelId, notification.id, dismissNotification, setActiveChannel])

  return (
    <div
      className={`notification-toast${notification.channelId ? ' notification-toast--clickable' : ''}`}
      onClick={notification.channelId ? handleClick : undefined}
      role={notification.channelId ? 'button' : undefined}
      tabIndex={notification.channelId ? 0 : undefined}
      onKeyDown={notification.channelId ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleClick() } : undefined}
    >
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
    </div>
  )
}
