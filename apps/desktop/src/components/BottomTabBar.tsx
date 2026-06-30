import { useRef, useEffect } from 'react'
import { LayoutDashboard, MessageSquare, User } from 'lucide-react'
import { useHaptics } from '../hooks/useHaptics'
import './BottomTabBar.css'

interface BottomTabBarProps {
  activeTab: number
  onTabChange: (tab: number) => void
  serverMentionCount?: number
  dmUnreadCount?: number
}

const TAB_COUNT = 3
const INDICATOR_INSET = 14

export default function BottomTabBar({
  activeTab,
  onTabChange,
  serverMentionCount = 0,
  dmUnreadCount = 0,
}: BottomTabBarProps) {
  const barRef = useRef<HTMLElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const { tap } = useHaptics()

  useEffect(() => {
    const bar = barRef.current
    const indicator = indicatorRef.current
    if (!bar || !indicator) return

    const tabWidth = bar.offsetWidth / TAB_COUNT
    indicator.style.left = `${activeTab * tabWidth + INDICATOR_INSET}px`
    indicator.style.width = `${tabWidth - INDICATOR_INSET * 2}px`
  }, [activeTab])

  const handleTabChange = (tab: number) => {
    if (tab !== activeTab) tap()
    onTabChange(tab)
  }

  return (
    <nav ref={barRef} className="bottom-tab-bar" role="navigation" aria-label="Main navigation">
      <div ref={indicatorRef} className="bottom-tab-bar__indicator" />

      <button
        className={`bottom-tab-bar__tab${activeTab === 0 ? ' bottom-tab-bar__tab--active' : ''}`}
        onClick={() => handleTabChange(0)}
        aria-label={`Servers${serverMentionCount > 0 ? `, ${serverMentionCount} mentions` : ''}`}
        aria-current={activeTab === 0 ? 'page' : undefined}
      >
        <LayoutDashboard className="bottom-tab-bar__icon" />
        <span className="bottom-tab-bar__label">Servers</span>
        {serverMentionCount > 0 && (
          <span className="bottom-tab-bar__badge" key={serverMentionCount}>
            {serverMentionCount > 99 ? '99+' : serverMentionCount}
          </span>
        )}
      </button>

      <button
        className={`bottom-tab-bar__tab${activeTab === 1 ? ' bottom-tab-bar__tab--active' : ''}`}
        onClick={() => handleTabChange(1)}
        aria-label={`Messages${dmUnreadCount > 0 ? `, ${dmUnreadCount} unread` : ''}`}
        aria-current={activeTab === 1 ? 'page' : undefined}
      >
        <MessageSquare className="bottom-tab-bar__icon" />
        <span className="bottom-tab-bar__label">Messages</span>
        {dmUnreadCount > 0 && (
          <span className="bottom-tab-bar__badge" key={dmUnreadCount}>
            {dmUnreadCount > 99 ? '99+' : dmUnreadCount}
          </span>
        )}
      </button>

      <button
        className={`bottom-tab-bar__tab${activeTab === 2 ? ' bottom-tab-bar__tab--active' : ''}`}
        onClick={() => handleTabChange(2)}
        aria-label="You"
        aria-current={activeTab === 2 ? 'page' : undefined}
      >
        <User className="bottom-tab-bar__icon" />
        <span className="bottom-tab-bar__label">You</span>
      </button>
    </nav>
  )
}
