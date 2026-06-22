import { LayoutDashboard, MessageSquare, User } from 'lucide-react'
import './BottomTabBar.css'

interface BottomTabBarProps {
  activeTab: number
  onTabChange: (tab: number) => void
  serverMentionCount?: number
  dmUnreadCount?: number
}

export default function BottomTabBar({
  activeTab,
  onTabChange,
  serverMentionCount = 0,
  dmUnreadCount = 0,
}: BottomTabBarProps) {
  return (
    <nav className="bottom-tab-bar" role="navigation" aria-label="Main navigation">
      <button
        className={`bottom-tab-bar__tab${activeTab === 0 ? ' bottom-tab-bar__tab--active' : ''}`}
        onClick={() => onTabChange(0)}
        aria-label={`Servers${serverMentionCount > 0 ? `, ${serverMentionCount} mentions` : ''}`}
        aria-current={activeTab === 0 ? 'page' : undefined}
      >
        <LayoutDashboard className="bottom-tab-bar__icon" />
        <span className="bottom-tab-bar__label">Servers</span>
        {serverMentionCount > 0 && (
          <span className="bottom-tab-bar__badge">
            {serverMentionCount > 99 ? '99+' : serverMentionCount}
          </span>
        )}
      </button>

      <button
        className={`bottom-tab-bar__tab${activeTab === 1 ? ' bottom-tab-bar__tab--active' : ''}`}
        onClick={() => onTabChange(1)}
        aria-label={`Messages${dmUnreadCount > 0 ? `, ${dmUnreadCount} unread` : ''}`}
        aria-current={activeTab === 1 ? 'page' : undefined}
      >
        <MessageSquare className="bottom-tab-bar__icon" />
        <span className="bottom-tab-bar__label">Messages</span>
        {dmUnreadCount > 0 && (
          <span className="bottom-tab-bar__badge">
            {dmUnreadCount > 99 ? '99+' : dmUnreadCount}
          </span>
        )}
      </button>

      <button
        className={`bottom-tab-bar__tab${activeTab === 2 ? ' bottom-tab-bar__tab--active' : ''}`}
        onClick={() => onTabChange(2)}
        aria-label="You"
        aria-current={activeTab === 2 ? 'page' : undefined}
      >
        <User className="bottom-tab-bar__icon" />
        <span className="bottom-tab-bar__label">You</span>
      </button>
    </nav>
  )
}
