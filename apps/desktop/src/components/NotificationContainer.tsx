import { useNotificationStore } from '../store/notificationStore'
import NotificationToast from './NotificationToast'
import './NotificationContainer.css'

export default function NotificationContainer() {
  const notifications = useNotificationStore((s) => s.notifications)

  if (notifications.length === 0) return null

  return (
    <div className="notification-container">
      {notifications.map((n) => (
        <NotificationToast key={n.id} notification={n} />
      ))}
    </div>
  )
}
