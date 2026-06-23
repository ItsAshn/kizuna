import { useState, memo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { Settings, ChevronLeft, LayoutDashboard, Ellipsis } from 'lucide-react'
import './ServerPanel.css'

interface ServerPanelProps {
  onLoginRequired?: (serverId: string) => void
  onOpenSettings?: () => void
  onOpenExport?: () => void
  onAddServer?: () => void
  onBackToServers?: () => void
}

interface ServerIconProps {
  server: { id: string; name: string; icon?: string | null; folder?: string | null }
  isActive: boolean
  isConnected: boolean
  mentions: number
  showRemove: boolean
  onClick: (serverId: string) => void
  onContextMenu: (e: React.MouseEvent, serverId: string) => void
}

const ServerIcon = memo(function ServerIcon({
  server,
  isActive,
  isConnected,
  mentions,
  showRemove,
  onClick,
  onContextMenu,
}: ServerIconProps) {
  return (
    <button
      className={`server-panel__icon ${isActive ? 'server-panel__icon--active' : ''}`}
      onClick={() => onClick(server.id)}
      aria-label={`${server.name}${isConnected ? ' — connected' : ' — not connected'}${mentions > 0 ? ` — ${mentions} mentions` : ''}`}
      aria-current={isActive ? 'page' : undefined}
      onContextMenu={(e) => onContextMenu(e, server.id)}
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
      {showRemove && (
        <span
          className="server-panel__remove-badge"
          onClick={(e) => onContextMenu(e, server.id)}
        >
          x
        </span>
      )}
    </button>
  )
})

export default function ServerPanel({ onLoginRequired, onOpenSettings, onOpenExport, onAddServer, onBackToServers }: ServerPanelProps) {
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
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())

  function handleHome() {
    setActiveServer(null)
    navigate('/')
  }

  const handleServerClick = useCallback((serverId: string) => {
    if (sessions[serverId]) {
      setActiveServer(serverId)
      navigate('/chat')
    } else if (onLoginRequired) {
      onLoginRequired(serverId)
    } else {
      navigate('/login/' + encodeURIComponent(serverId))
    }
  }, [sessions, setActiveServer, navigate, onLoginRequired])

  const handleRemove = useCallback((e: React.MouseEvent, serverId: string) => {
    e.stopPropagation()
    if (showRemove === serverId) {
      removeServer(serverId)
      setShowRemove(null)
    } else {
      setShowRemove(serverId)
    }
  }, [showRemove, removeServer])

  const uncategorizedServers = servers.filter((s) => !s.folder)
  const folderNames = [...new Set(servers.filter((s) => s.folder).map((s) => s.folder!))].sort()

  return (
    <div className="server-panel">
      <button
        className={`server-panel__icon server-panel__icon--home ${!activeServerId ? 'server-panel__icon--active' : ''}`}
        onClick={handleHome}
        title="Home"
        aria-label="Home"
      >
        <LayoutDashboard size={20} />
      </button>

      <div className="server-panel__divider" />

      <div className="server-panel__list">
        {/* Uncategorized servers */}
        {uncategorizedServers.map((server) => (
          <ServerIcon
            key={server.id}
            server={server}
            isActive={activeServerId === server.id}
            isConnected={!!sessions[server.id]}
            mentions={serverMentionCounts[server.id] ?? 0}
            showRemove={showRemove === server.id}
            onClick={handleServerClick}
            onContextMenu={handleRemove}
          />
        ))}

        {/* Folder groups */}
        {folderNames.map((folder) => {
          const folderServers = servers.filter((s) => s.folder === folder)
          const isCollapsed = collapsedFolders.has(folder)
          return (
            <div key={folder} className="server-panel__folder">
              <button
                className="server-panel__folder-toggle"
                onClick={() => setCollapsedFolders((prev) => {
                  const next = new Set(prev)
                  if (next.has(folder)) next.delete(folder)
                  else next.add(folder)
                  return next
                })}
                title={isCollapsed ? `Expand ${folder}` : `Collapse ${folder}`}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${folder}`}
              >
                <span className={`server-panel__folder-arrow${isCollapsed ? ' server-panel__folder-arrow--collapsed' : ''}`}>▾</span>
                {isCollapsed && folderServers.length > 0 && (
                  <span className="server-panel__folder-preview">
                    {folderServers[0].name.slice(0, 2).toUpperCase()}
                  </span>
                )}
                {!isCollapsed && folderServers.map((server) => (
                  <ServerIcon
                    key={server.id}
                    server={server}
                    isActive={activeServerId === server.id}
                    isConnected={!!sessions[server.id]}
                    mentions={serverMentionCounts[server.id] ?? 0}
                    showRemove={showRemove === server.id}
                    onClick={handleServerClick}
                    onContextMenu={handleRemove}
                  />
                ))}
              </button>
            </div>
          )
        })}
      </div>

      <div className="server-panel__divider" />

      <button
        className="server-panel__icon server-panel__icon--action"
        onClick={onAddServer}
        title="Add Server"
        aria-label="Add server"
      >
        +
      </button>

      <button
        className="server-panel__icon server-panel__icon--action"
        onClick={onOpenExport}
        title="Export / Import"
        aria-label="Export / Import"
      >
        <Ellipsis size={18} />
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
