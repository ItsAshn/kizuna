import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import ExportModal from './ExportModal'
import '../styles/server-rail.css'

export default function ServerList() {
  const navigate = useNavigate()
  const {
    servers,
    sessions,
    activeServerId,
    setActiveServer,
    removeServer,
    setActiveSession,
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
    <div className="server-rail">
      <button
        className={`server-rail__item server-rail__item--home ${!activeServerId ? 'server-rail__item--active' : ''}`}
        onClick={handleHome}
        title="Home"
      >
        [D]
      </button>

      <div className="server-rail__separator" />

      {servers.map((server) => {
        const isActive = activeServerId === server.id
        const isConnected = !!sessions[server.id]
        const mentions = mentionCounts[server.id] ?? 0

        return (
          <button
            key={server.id}
            className={`server-rail__item ${isActive ? 'server-rail__item--active' : ''}`}
            onClick={() => handleServerClick(server.id)}
            onContextMenu={(e) => { e.preventDefault(); handleRemove(e, server.id) }}
            title={server.name}
          >
            {server.icon ? (
              <img src={server.icon} alt="" className="server-rail__item-icon" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            ) : (
              server.name.slice(0, 2).toUpperCase()
            )}
            <span className={`server-rail__dot ${isConnected ? 'server-rail__dot--online' : 'server-rail__dot--offline'}`} />
            {mentions > 0 && <span className="server-rail__badge">{mentions > 99 ? '99+' : mentions}</span>}
            {showRemove === server.id && (
              <span
                className="server-rail__remove-badge"
                onClick={(e) => handleRemove(e, server.id)}
              >
                x
              </span>
            )}
          </button>
        )
      })}

      <button
        className="server-rail__add-btn"
        onClick={() => navigate('/')}
        title="Add Server"
      >
        +
      </button>

      <button
        className="server-rail__settings-btn"
        onClick={() => setShowExport(true)}
        title="Export / Import"
      >
        ...
      </button>

      <div style={{ flex: 1 }} />

      <button
        className="server-rail__settings-btn"
        style={{ fontSize: '16px' }}
        onClick={() => {
          if (activeServerId) navigate('/chat')
        }}
        title="Settings"
      >
        &#9881;
      </button>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  )
}
