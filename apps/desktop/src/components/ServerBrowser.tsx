import { useState, useEffect, useMemo } from 'react'
import { Lock, Users, Globe, Search, ArrowUpDown } from 'lucide-react'
import { fetchPublicServers } from '@kizuna/shared'
import type { PublicServerEntry } from '@kizuna/shared'
import './ServerBrowser.css'

const DEFAULT_REGISTRY_URL = 'https://server.use-kizuna.com'

interface Props {
  onConnect: (url: string) => void
  registryUrl?: string
}

type SortKey = 'name' | 'players'

export default function ServerBrowser({ onConnect, registryUrl = DEFAULT_REGISTRY_URL }: Props) {
  const [servers, setServers] = useState<PublicServerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('players')
  const [showPasswordProtected, setShowPasswordProtected] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError('')
      try {
        const data = await fetchPublicServers(registryUrl)
        if (!cancelled) setServers(data)
      } catch {
        if (!cancelled) setError('Could not load server list')
      }
      if (!cancelled) setLoading(false)
    }
    load()
    const interval = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [registryUrl])

  const filtered = useMemo(() => {
    let list = servers
    if (!showPasswordProtected) {
      list = list.filter((s) => !s.passwordProtected)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      )
    }
    list = [...list].sort((a, b) => {
      if (sortBy === 'players') return b.playerCount - a.playerCount
      return a.name.localeCompare(b.name)
    })
    return list
  }, [servers, search, sortBy, showPasswordProtected])

  return (
    <div className="server-browser">
      <div className="server-browser__controls">
        <div className="server-browser__search">
          <Search size={16} className="server-browser__search-icon" />
          <input
            className="server-browser__search-input"
            placeholder="Search servers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          className="server-browser__sort"
          onClick={() => setSortBy((s) => (s === 'name' ? 'players' : 'name'))}
          title={`Sort by ${sortBy === 'name' ? 'active users' : 'name'}`}
        >
          <ArrowUpDown size={14} />
          {sortBy === 'name' ? 'Name' : 'Active'}
        </button>
        <button
          className={`server-browser__filter ${!showPasswordProtected ? 'server-browser__filter--off' : ''}`}
          onClick={() => setShowPasswordProtected((v) => !v)}
          title={showPasswordProtected ? 'Showing all servers' : 'Hiding password-protected servers'}
        >
          <Lock size={12} />
          <span className="server-browser__filter-label">Password</span>
          <span className="server-browser__filter-dot" />
        </button>
      </div>

      {loading && servers.length === 0 && (
        <p className="server-browser__status">Loading servers...</p>
      )}
      {error && servers.length === 0 && (
        <p className="server-browser__status server-browser__status--error">{error}</p>
      )}
      {!loading && !error && filtered.length === 0 && (
        <p className="server-browser__status">No servers found</p>
      )}

      <div className="server-browser__grid">
        {filtered.map((server) => (
          <button
            key={server.url}
            className="server-browser__card"
            onClick={() => onConnect(server.url)}
          >
            <div className="server-browser__card-header">
              <div className="server-browser__card-icon">
                {server.icon ? (
                  <img src={server.icon} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                ) : (
                  server.name.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="server-browser__card-badges">
                {server.passwordProtected && (
                  <span className="server-browser__badge server-browser__badge--lock" title="Password protected">
                    <Lock size={10} />
                  </span>
                )}
                <span className="server-browser__badge server-browser__badge--players" title={`${server.playerCount} active user${server.playerCount !== 1 ? 's' : ''}`}>
                  <Users size={10} />
                  {server.playerCount}
                </span>
              </div>
            </div>
            <h3 className="server-browser__card-name">{server.name}</h3>
            <p className="server-browser__card-desc">
              {server.description || 'No description'}
            </p>
            <div className="server-browser__card-connect">
              <Globe size={12} />
              Connect
            </div>
          </button>
        ))}
      </div>

      {!loading && !error && servers.length > 0 && (
        <p className="server-browser__count">
          {servers.length} server{servers.length !== 1 ? 's' : ''} online
        </p>
      )}
    </div>
  )
}
