import { useState, memo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { Settings, LayoutDashboard, Ellipsis, Plus, ChevronDown } from 'lucide-react'
import { useMobile } from '../hooks/useMobile'
import ContextMenu from './ContextMenu'
import type { ContextMenuSection } from './ContextMenu'
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
  onContextMenu: (e: React.MouseEvent) => void
  onClick: (serverId: string) => void
  draggable: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
}

const ServerIcon = memo(function ServerIcon({
  server,
  isActive,
  isConnected,
  mentions,
  onContextMenu,
  onClick,
  draggable,
  onDragStart,
  onDragEnd,
}: ServerIconProps) {
  return (
    <button
      className={`server-panel__icon${isActive ? ' server-panel__icon--active' : ''}`}
      onClick={() => onClick(server.id)}
      aria-label={`${server.name}${isConnected ? ' — connected' : ' — not connected'}${mentions > 0 ? ` — ${mentions} mentions` : ''}`}
      aria-current={isActive ? 'page' : undefined}
      onContextMenu={onContextMenu}
      title={server.name}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
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
      <span className={`server-panel__dot${isConnected ? ' server-panel__dot--online' : ''}`} />
      {mentions > 0 && (
        <span className="server-panel__badge">
          {mentions > 99 ? '99+' : mentions}
        </span>
      )}
    </button>
  )
})

export default function ServerPanel({ onLoginRequired, onOpenSettings, onOpenExport, onAddServer, onBackToServers: _onBackToServers }: ServerPanelProps) {
  const navigate = useNavigate()
  const isMobile = useMobile()
  const {
    servers,
    sessions,
    activeServerId,
    setActiveServer,
    removeServer,
    reorderServers,
  } = useServerStore()
  const serverMentionCounts = useChatStore((s) => s.serverMentionCounts)
  const [contextMenu, setContextMenu] = useState<{ serverId: string; x: number; y: number } | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [drag, setDrag] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<{ serverId: string; position: 'above' | 'below' } | null>(null)

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

  const handleContextMenu = useCallback((e: React.MouseEvent, serverId: string) => {
    e.preventDefault()
    setContextMenu({ serverId, x: e.clientX, y: e.clientY })
  }, [])

  const contextMenuSections: ContextMenuSection[] = contextMenu
    ? [{
        items: [
          {
            label: 'Remove Server',
            onClick: () => {
              removeServer(contextMenu.serverId)
              setContextMenu(null)
            },
            danger: true,
          },
        ],
      }]
    : []

  function handleDragStart(e: React.DragEvent, serverId: string) {
    if (isMobile) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', serverId)
    setDrag(serverId)
  }

  function handleDragEnd() {
    setDrag(null)
    setDragOver(null)
  }

  function handleDragOver(e: React.DragEvent, serverId: string) {
    if (!drag || drag === serverId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDragOver({ serverId, position: e.clientY < rect.top + rect.height / 2 ? 'above' : 'below' })
  }

  function handleDragLeave(e: React.DragEvent, serverId: string) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      setDragOver((prev) => (prev?.serverId === serverId ? null : prev))
    }
  }

  function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault()
    if (!drag || !dragOver || drag === targetId) return
    reorderServers(drag, targetId, dragOver.position)
    setDrag(null)
    setDragOver(null)
  }

  function renderServerIcon(server: typeof servers[number]) {
    const serverId = server.id
    const isDragging = drag === serverId
    const isDropAbove = dragOver?.serverId === serverId && dragOver.position === 'above'
    const isDropBelow = dragOver?.serverId === serverId && dragOver.position === 'below'
    let wrapClass = 'server-panel__icon-wrap'
    if (isDragging) wrapClass += ' server-panel__icon-wrap--dragging'
    if (isDropAbove) wrapClass += ' server-panel__icon-wrap--drop-above'
    if (isDropBelow) wrapClass += ' server-panel__icon-wrap--drop-below'

    return (
      <div
        key={serverId}
        className={wrapClass}
        onDragOver={(e) => handleDragOver(e, serverId)}
        onDragLeave={(e) => handleDragLeave(e, serverId)}
        onDrop={(e) => handleDrop(e, serverId)}
      >
        <ServerIcon
          server={server}
          isActive={activeServerId === serverId}
          isConnected={!!sessions[serverId]}
          mentions={serverMentionCounts[serverId] ?? 0}
          onContextMenu={(e) => handleContextMenu(e, serverId)}
          onClick={handleServerClick}
          draggable={!isMobile}
          onDragStart={(e) => handleDragStart(e, serverId)}
          onDragEnd={handleDragEnd}
        />
      </div>
    )
  }

  const uncategorizedServers = servers.filter((s) => !s.folder)
  const folderNames = [...new Set(servers.filter((s) => s.folder).map((s) => s.folder!))].sort()

  return (
    <div className="server-panel">
      <button
        className={`server-panel__icon server-panel__icon--home${!activeServerId ? ' server-panel__icon--active' : ''}`}
        onClick={handleHome}
        title="Home"
        aria-label="Home"
      >
        <LayoutDashboard size={20} />
      </button>

      <div className="server-panel__divider" />

      <div className="server-panel__list">
        {uncategorizedServers.map((server) => renderServerIcon(server))}

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
                <ChevronDown
                  size={12}
                  className={`server-panel__folder-arrow${isCollapsed ? ' server-panel__folder-arrow--collapsed' : ''}`}
                />
                {isCollapsed && folderServers.length > 0 && (
                  <div className="server-panel__folder-preview">
                    {folderServers[0].name.slice(0, 2).toUpperCase()}
                  </div>
                )}
              </button>
              <div className={`server-panel__folder-content${isCollapsed ? ' server-panel__folder-content--collapsed' : ''}`}>
                {folderServers.map((server) => renderServerIcon(server))}
              </div>
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
        <Plus size={18} />
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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sections={contextMenuSections}
          onClose={() => setContextMenu(null)}
          title={servers.find((s) => s.id === contextMenu.serverId)?.name}
        />
      )}
    </div>
  )
}