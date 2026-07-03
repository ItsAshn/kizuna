import { useCallback } from 'react'
import type { DMChannelData } from '@kizuna/shared'
import { RefreshCw } from 'lucide-react'
import { useHaptics } from '../../hooks/useHaptics'
import { usePullToRefresh } from '../../hooks/usePullToRefresh'
import { useMobile } from '../../hooks/useMobile'
import type { NavEntry } from '../../hooks/useMobileNavigation'
import './MobileMessagesTab.css'

interface MobileMessagesTabProps {
  dmChannels: DMChannelData[]
  unreadCounts: Record<string, number>
  onPushView: (entry: NavEntry) => void
}

export default function MobileMessagesTab({
  dmChannels,
  unreadCounts,
  onPushView,
}: MobileMessagesTabProps) {
  const haptics = useHaptics()
  const isMobile = useMobile()

  const handleRefresh = useCallback(async () => {}, [])

  const { containerRef, pulling, refreshing, pullDistance, indicatorOpacity } =
    usePullToRefresh({
      onRefresh: handleRefresh,
      disabled: !isMobile,
    })

  const handleDMTap = useCallback(
    (dm: DMChannelData) => {
      haptics.tap()
      onPushView({ type: 'dm', dmChannelId: dm.id })
    },
    [onPushView, haptics],
  )

  return (
    <div className="mobile-tab mobile-messages-tab">
      <div className="mobile-tab__header">
        <h1 className="mobile-tab__title">Messages</h1>
      </div>
      <div
        ref={containerRef}
        className="mobile-tab__body mobile-messages-tab__body"
      >
        <div
          className="mobile-tab__pull-indicator"
          style={{
            height: `${pullDistance}px`,
            opacity: indicatorOpacity,
          }}
        >
          <div className="mobile-tab__pull-spinner">
            <RefreshCw
              size={22}
              className={refreshing ? 'mobile-tab__pull-spinner--spinning' : ''}
              style={{
                transform: pulling && !refreshing
                  ? `rotate(${Math.min(pullDistance * 3, 360)}deg)`
                  : undefined,
              }}
            />
          </div>
        </div>

        {dmChannels.length === 0 ? (
          <div className="mobile-tab__empty">
            <div className="mobile-tab__empty-icon">
              <span className="mobile-tab__empty-emoji">💬</span>
            </div>
            <p className="mobile-tab__empty-text">No messages yet</p>
            <p className="mobile-tab__empty-sub">
              Join a server and start a conversation
            </p>
          </div>
        ) : (
          dmChannels.map((dm) => {
            const unread = unreadCounts[dm.id] ?? 0
            const hasUnread = unread > 0
            return (
              <button
                key={dm.id}
                className={`mobile-dm-item${hasUnread ? ' mobile-dm-item--unread' : ''}`}
                onClick={() => handleDMTap(dm)}
              >
                <div className="mobile-dm-item__avatar">
                  {dm.other_avatar ? (
                    <img
                      src={dm.other_avatar}
                      alt=""
                      className="mobile-dm-item__avatar-img"
                      onError={(e) => {
                        ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                      }}
                    />
                  ) : (
                    dm.other_display_name?.[0]?.toUpperCase() || '?'
                  )}
                </div>
                <div className="mobile-dm-item__info">
                  <p className="mobile-dm-item__name">
                    {dm.other_display_name || dm.other_username}
                  </p>
                  <p className="mobile-dm-item__username">
                    @{dm.other_username}
                  </p>
                </div>
                {hasUnread && (
                  <span className="mobile-dm-item__badge">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
