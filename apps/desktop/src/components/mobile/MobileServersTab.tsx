import { useCallback } from 'react'
import type { SavedServer } from '@kizuna/shared'
import { Settings, Plus, RefreshCw } from 'lucide-react'
import { useHaptics } from '../../hooks/useHaptics'
import { usePullToRefresh } from '../../hooks/usePullToRefresh'
import { useMobile } from '../../hooks/useMobile'
import type { NavEntry } from '../../hooks/useMobileNavigation'
import './MobileServersTab.css'

interface MobileServersTabProps {
  servers: SavedServer[]
  sessions: Record<string, { serverId: string; url: string; token: string }>
  serverMentionCounts: Record<string, number>
  onPushView: (entry: NavEntry) => void
  onLoginRequired: (serverId: string) => void
  onOpenSettings: () => void
  onOpenConnect: () => void
}

export default function MobileServersTab({
  servers,
  sessions,
  serverMentionCounts,
  onPushView,
  onLoginRequired,
  onOpenSettings,
  onOpenConnect,
}: MobileServersTabProps) {
  const haptics = useHaptics()
  const isMobile = useMobile()

  const handleRefresh = useCallback(async () => {
    // Refresh is handled by parent; pull-to-refresh provides the gesture
  }, [])

  const { containerRef, pulling, refreshing, pullDistance, indicatorOpacity } =
    usePullToRefresh({
      onRefresh: handleRefresh,
      disabled: !isMobile,
    })

  const handleServerTap = useCallback(
    (server: SavedServer) => {
      haptics.tap()
      if (sessions[server.id]) {
        onPushView({ type: 'server', serverId: server.id })
      } else {
        onLoginRequired(server.id)
      }
    },
    [sessions, onPushView, onLoginRequired, haptics],
  )

  return (
    <div className="mobile-tab mobile-servers-tab">
      <div className="mobile-servers-tab__header">
        <h1 className="mobile-tab__title">Servers</h1>
        <button
          className="mobile-tab__header-btn"
          onClick={() => {
            haptics.tap()
            onOpenSettings()
          }}
          aria-label="Settings"
        >
          <Settings size={20} />
        </button>
      </div>
      <div
        ref={containerRef}
        className="mobile-tab__body mobile-servers-tab__body"
      >
        {/* Pull-to-refresh indicator */}
        <div
          className="mobile-servers-tab__pull-indicator"
          style={{
            height: `${pullDistance}px`,
            opacity: indicatorOpacity,
          }}
        >
          <div className="mobile-servers-tab__pull-spinner">
            <RefreshCw
              size={22}
              className={refreshing ? 'mobile-servers-tab__pull-spinner--spinning' : ''}
              style={{
                transform: pulling && !refreshing
                  ? `rotate(${Math.min(pullDistance * 3, 360)}deg)`
                  : undefined,
              }}
            />
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="mobile-tab__empty">
            <div className="mobile-tab__empty-icon">
              <span className="mobile-tab__empty-emoji">🌐</span>
            </div>
            <p className="mobile-tab__empty-text">No servers yet</p>
            <p className="mobile-tab__empty-sub">
              Connect to a self-hosted server to get started
            </p>
          </div>
        ) : (
          <div className="mobile-server-grid">
            {servers.map((server) => {
              const isConnected = !!sessions[server.id]
              const mentions = serverMentionCounts[server.id] ?? 0
              return (
                <button
                  key={server.id}
                  className={`mobile-server-card${isConnected ? ' mobile-server-card--connected' : ''}`}
                  onClick={() => handleServerTap(server)}
                >
                  <div className="mobile-server-card__icon">
                    {server.icon ? (
                      <img
                        src={server.icon}
                        alt=""
                        className="mobile-server-card__icon-img"
                        onError={(e) => {
                          ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                        }}
                      />
                    ) : (
                      <span className="mobile-server-card__icon-text">
                        {server.name.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    {isConnected && (
                      <span className="mobile-server-card__dot" />
                    )}
                  </div>
                  <div className="mobile-server-card__info">
                    <p className="mobile-server-card__name">{server.name}</p>
                    <p className="mobile-server-card__url">{server.url}</p>
                  </div>
                  <div className="mobile-server-card__chevron">
                    <svg
                      width="8"
                      height="14"
                      viewBox="0 0 8 14"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        d="M1 1L7 7L1 13"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  {mentions > 0 && (
                    <span className="mobile-server-card__badge">
                      {mentions > 99 ? '99+' : mentions}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className="mobile-tab__footer">
        <button
          className="mobile-tab__cta"
          onClick={() => {
            haptics.medium()
            onOpenConnect()
          }}
        >
          <Plus size={18} />
          Connect to Server
        </button>
      </div>
    </div>
  )
}
