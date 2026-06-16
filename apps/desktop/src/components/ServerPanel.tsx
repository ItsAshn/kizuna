import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { Settings } from 'lucide-react'
import '../styles/server-panel.css'

interface ServerPanelProps {
  onLoginRequired?: (serverId: string) => void
  onOpenSettings?: () => void
  onOpenExport?: () => void
}

export default function ServerPanel({ onLoginRequired, onOpenSettings, onOpenExport }: ServerPanelProps) {
  const navigate = useNavigate()
  const {
    servers,
    sessions,
    activeServerId,
    setActiveServer,
    removeServer,
  } = useServerStore()
  const serverMentionCounts = useChatStore((s) => s.serverMentionCounts)
  const [showRemove, setShowRemove] = useState<string | null>(null)
  function handleHome() {
    setActiveServer(null)
    navigate('/')
  }

  function handleServerClick(serverId: string) {
    if (sessions[serverId]) {
      setActiveServer(serverId)
      navigate('/chat')
    } else if (onLoginRequired) {
      onLoginRequired(serverId)
    } else {
      navigate('/login/' + encodeURIComponent(serverId))
    }
  }

  function handleRemove(e: React.MouseEvent, serverId: string) {
    e.stopPropagation()
    if (showRemove === serverId) {
      removeServer(serverId)
      setShowRemove(null)
    } else {
      setShowRemove(serverId)
    }
  }

  return (
    <div className="server-panel">
      <button
        className={`server-panel__icon server-panel__icon--home ${!activeServerId ? 'server-panel__icon--active' : ''}`}
        onClick={handleHome}
        title="Home"
        aria-label="Home"
      >
        [D]
      </button>

      <div className="server-panel__divider" />

      <div className="server-panel__list">
        {servers.map((server) => {
          const isActive = activeServerId === server.id
          const isConnected = !!sessions[server.id]
          const mentions = serverMentionCounts[server.id] ?? 0

          return (
            <button
              key={server.id}
              className={`server-panel__icon ${isActive ? 'server-panel__icon--active' : ''}`}
              onClick={() => handleServerClick(server.id)}
              aria-label={`${server.name}${isConnected ? ' — connected' : ' — not connected'}${mentions > 0 ? ` — ${mentions} mentions` : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onContextMenu={(e) => {
                e.preventDefault()
                handleRemove(e, server.id)
              }}
              title={server.name}
            >
              {server.icon ? (
                <img
                  src={server.icon}
                  alt=""
                  className="server-panel__icon-img"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none'
                  }}
                />
              ) : (
                server.name.slice(0, 2).toUpperCase()
              )}
              <span className={`server-panel__dot ${isConnected ? 'server-panel__dot--online' : ''}`} />
              {mentions > 0 && (
                <span className="server-panel__badge">
                  {mentions > 99 ? '99+' : mentions}
                </span>
              )}
              {showRemove === server.id && (
                <span
                  className="server-panel__remove-badge"
                  onClick={(e) => handleRemove(e, server.id)}
                >
                  x
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="server-panel__divider" />

      <button
        className="server-panel__icon server-panel__icon--action"
        onClick={() => navigate('/')}
        title="Add Server"
        aria-label="Add server"
      >
        +
      </button>

      <button
        className="server-panel__icon server-panel__icon--action"
        onClick={onOpenExport}
        title="Export / Import"
      >
        ...
      </button>

      <button
        className="server-panel__icon server-panel__icon--action"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <Settings size={18} />
      </button>

    </div>
  )
}
