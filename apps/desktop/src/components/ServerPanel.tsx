import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import ExportModal from './ExportModal'
import '../styles/server-panel.css'

export default function ServerPanel() {
  const navigate = useNavigate()
  const {
    servers,
    sessions,
    activeServerId,
    setActiveServer,
    removeServer,
  } = useServerStore()
  const mentionCounts = useChatStore((s) => s.mentionCounts)
  const [showRemove, setShowRemove] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)

  function handleHome() {
    setActiveServer(null)
    navigate('/')
  }

  function handleServerClick(serverId: string) {
    if (sessions[serverId]) {
      setActiveServer(serverId)
      navigate('/chat')
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
      >
        [D]
      </button>

      <div className="server-panel__divider" />

      <div className="server-panel__list">
        {servers.map((server) => {
          const isActive = activeServerId === server.id
          const isConnected = !!sessions[server.id]
          const mentions = mentionCounts[server.id] ?? 0

          return (
            <button
              key={server.id}
              className={`server-panel__icon ${isActive ? 'server-panel__icon--active' : ''}`}
              onClick={() => handleServerClick(server.id)}
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
      >
        +
      </button>

      <button
        className="server-panel__icon server-panel__icon--action"
        onClick={() => setShowExport(true)}
        title="Export / Import"
      >
        ...
      </button>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  )
}
