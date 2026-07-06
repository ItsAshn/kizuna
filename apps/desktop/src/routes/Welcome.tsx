import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { fetchDMChannels, fetchServerInfo, resolveInviteCode } from '@kizuna/shared'
import type { ServerInfo } from '@kizuna/shared'
import { useAuth } from '../hooks/useAuth'
import { useMobile } from '../hooks/useMobile'
import { useUpdaterActions } from '../hooks/useUpdater'
import type { DMChannelData } from '@kizuna/shared'
import { Settings, BookOpen, GitBranch, Bug } from 'lucide-react'
import AuthForm from '../components/AuthForm'
import BackupTokenModal from '../components/BackupTokenModal'
import ServerConnectForm from '../components/ServerConnectForm'
import ServerBrowser from '../components/ServerBrowser'
import Landing from './Landing'
import './Welcome.css'

const INVITE_CODE_RE = /^[A-Za-z0-9+\-_=]+\.[A-Za-z0-9+\-_=]+$/

function isInviteCode(input: string): boolean {
  return INVITE_CODE_RE.test(input.trim())
}

interface ServerDMs {
  serverId: string
  serverName: string
  channels: DMChannelData[]
}

export default function Welcome({ isLanding = false, onOpenSettings }: { isLanding?: boolean; onOpenSettings: () => void }) {
  const navigate = useNavigate()
  const isMobile = useMobile()
  const { addServer, setActiveSession, servers } = useServerStore()
  const mentionCounts = useChatStore((s) => s.mentionCounts)
  const { getVersion } = useUpdaterActions()
  const [serverDMs, setServerDMs] = useState<ServerDMs[]>([])
  const [dmsLoading, setDmsLoading] = useState(false)
  const [serverStatus, setServerStatus] = useState<Record<string, 'checking' | 'online' | 'offline'>>({})
  const [appVersion, setAppVersion] = useState('')

  const [showLanding, setShowLanding] = useState(() => {
    return isLanding && localStorage.getItem('kizuna-landing-dismissed') !== 'true'
  })
  const [showConnect, setShowConnect] = useState(false)
  const [serverUrl, setServerUrl] = useState('')
  const [serverInfo, setServerInfo] = useState<ServerInfo | { serverUrl: string; name: string; description: string } | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [dashboardTab, setDashboardTab] = useState<'saved' | 'explore'>('saved')

  const { authenticate, loading, error, setError, backupToken, clearBackupToken } = useAuth(serverUrl)

  useEffect(() => {
    async function loadDMs() {
      if (servers.length === 0) { setServerDMs([]); return }
      setDmsLoading(true)
      const results: ServerDMs[] = []
      for (const server of servers) {
        try {
          const channels = await fetchDMChannels(server.url)
          if (channels.length > 0) {
            results.push({ serverId: server.id, serverName: server.name, channels: channels.slice(0, 3) })
          }
        } catch { /* ignore */ }
      }
      setServerDMs(results)
      setDmsLoading(false)
    }
    loadDMs()
  }, [servers.length])

  useEffect(() => {
    if (servers.length === 0) { setServerStatus({}); return }
    setServerStatus((prev) => {
      const next: Record<string, 'checking' | 'online' | 'offline'> = {}
      for (const server of servers) next[server.id] = prev[server.id] ?? 'checking'
      return next
    })
    servers.forEach((server) => {
      fetchServerInfo(server.url)
        .then(() => setServerStatus((prev) => ({ ...prev, [server.id]: 'online' })))
        .catch(() => setServerStatus((prev) => ({ ...prev, [server.id]: 'offline' })))
    })
  }, [servers.length])

  useEffect(() => {
    getVersion().then(setAppVersion)
  }, [getVersion])

  async function handleConnect(urlToUse: string) {
    if (!urlToUse.trim()) return
    setError('')
    try {
      if (isInviteCode(urlToUse)) {
        const resolved = await resolveInviteCode(urlToUse.trim())
        setServerInfo(resolved)
        setServerUrl(resolved.serverUrl)
      } else {
        const resolved = await fetchServerInfo(urlToUse.trim())
        setServerInfo(resolved)
        setServerUrl(urlToUse.trim())
      }
      setShowConnect(true)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string }
      setError(e.response?.data?.error || e.message || 'Could not reach server. Check the URL or invite code and try again.')
    }
  }

  async function handleAuth() {
    const { success, result } = await authenticate({
      username,
      password,
      isRegister,
      displayName,
      serverPassword,
    })
    if (!success || !result) return

    const id = serverUrl.trim()
    addServer({
      id,
      name: serverInfo?.name || serverUrl,
      url: id,
      icon: (serverInfo as ServerInfo | null)?.icon || undefined,
      addedAt: Date.now(),
    })

    setActiveSession({
      serverId: id,
      url: id,
      token: result.token,
      user: result.user,
    })

    if (!result.backuptoken) {
      navigate('/chat')
    }
  }

  if (showConnect && serverUrl) {
    return (
      <div className="welcome">
        {backupToken && (
          <BackupTokenModal
            backuptoken={backupToken}
            onComplete={() => {
              clearBackupToken()
              navigate('/chat')
            }}
          />
        )}
        <div className="welcome__container">
          <div className="welcome__branding">
            <img src="/Logo.svg" alt="Kizuna" className="welcome__logo" />
            <h1 className="welcome__title">Kizuna</h1>
            <p className="welcome__subtitle">Self-hosted voice & chat</p>
          </div>

          <div className="welcome__card">
            <AuthForm
              serverName={(serverInfo as ServerInfo | null)?.name || ''}
              serverUrl={serverUrl}
              serverIcon={(serverInfo as ServerInfo | null)?.icon}
              serverDescription={(serverInfo as ServerInfo | null)?.description}
              isRegister={isRegister}
              setIsRegister={setIsRegister}
              username={username}
              setUsername={setUsername}
              password={password}
              setPassword={setPassword}
              displayName={displayName}
              setDisplayName={setDisplayName}
              serverPassword={serverPassword}
              setServerPassword={setServerPassword}
              serverPasswordProtected={!!(serverInfo as ServerInfo | null)?.passwordProtected}
              error={error}
              loading={loading}
              onSubmit={handleAuth}
              onBack={() => { setShowConnect(false); setServerInfo(null); setServerUrl(''); setError('') }}
              backLabel="Back to Dashboard"
              onForgotPassword={() => navigate(`/reset-password/${encodeURIComponent(serverUrl)}`)}
            />
          </div>
        </div>
      </div>
    )
  }

  if (showConnect) {
    return (
      <div className="welcome">
        <div className="welcome__container">
          <div className="welcome__branding">
            <img src="/Logo.svg" alt="Kizuna" className="welcome__logo" />
            <h1 className="welcome__title">Kizuna</h1>
            <p className="welcome__subtitle">Self-hosted voice & chat</p>
          </div>

          <div className="welcome__card">
            <h2 className="welcome__card-title">Connect to a Server</h2>
            <ServerConnectForm
              onConnect={(resolvedUrl, info) => {
                setServerUrl(resolvedUrl)
                setServerInfo(info)
              }}
              savedServers={servers.map((s) => ({ id: s.id, name: s.name, url: s.url }))}
              onBack={() => { setShowConnect(false); setError('') }}
              backLabel="Back to Dashboard"
            />
          </div>
        </div>
      </div>
    )
  }

  if (showLanding) {
    return <Landing onConnect={handleConnect} onEnterApp={() => { setShowLanding(false); localStorage.setItem('kizuna-landing-dismissed', 'true') }} />
  }

  return (
    <div className="welcome welcome--dashboard">
      <div className="welcome__branding">
        <img src="/Logo.svg" alt="Kizuna" className="welcome__logo" />
        <h1 className="welcome__title">Kizuna</h1>
        <p className="welcome__subtitle">Self-hosted voice & chat</p>
        <button
          className="welcome__dev-toggle"
          onClick={() => setShowLanding((v) => !v)}
        >
          About Kizuna
        </button>
      </div>

      <div className="welcome__tabs">
        <button
          className={`welcome__tab ${dashboardTab === 'saved' ? 'welcome__tab--active' : ''}`}
          onClick={() => setDashboardTab('saved')}
        >
          Saved Servers
        </button>
        <button
          className={`welcome__tab ${dashboardTab === 'explore' ? 'welcome__tab--active' : ''}`}
          onClick={() => setDashboardTab('explore')}
        >
          Explore
        </button>
      </div>

      {dashboardTab === 'explore' ? (
        <div className="welcome__explore">
          <ServerBrowser onConnect={handleConnect} />
        </div>
      ) : (
        <>
      <div className="welcome__dashboard-grid">
        <div className="welcome__dashboard-panel">
          <div className="welcome__dashboard-panel-header">
            <span className="welcome__dashboard-panel-label">Servers</span>
            <span className="welcome__dashboard-panel-count">{servers.length} saved</span>
          </div>
          <div className="welcome__dashboard-panel-body">
            {servers.length === 0 ? (
              <div className="welcome__dashboard-empty">
                <p className="welcome__dashboard-empty-text">No servers yet</p>
                <p className="welcome__dashboard-empty-sub">Click Connect below to add one</p>
              </div>
            ) : (
              servers.map((server) => {
                const mentions = mentionCounts[server.id] ?? 0
                return (
                  <button key={server.id} className="welcome__server-item" onClick={() => handleConnect(server.url)}>
                    <div className="welcome__server-icon">
                      {server.icon ? (
                        <img src={server.icon} alt="" className="welcome__server-icon-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                      ) : server.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="welcome__server-info">
                      <p className="welcome__server-name">{server.name}</p>
                      <p className="welcome__server-url">{server.url}</p>
                    </div>
                    {mentions > 0 && <span className="sidebar__unread-badge">{mentions > 99 ? '99+' : mentions}</span>}
                    <span className="welcome__server-connect-label">connect</span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {!isMobile && (
          <>
            <div className="welcome__dashboard-panel">
              <div className="welcome__dashboard-panel-header">
                <span className="welcome__dashboard-panel-label">Direct Messages</span>
              </div>
              <div className="welcome__dashboard-panel-body">
                {dmsLoading ? (
                  <p className="welcome__dashboard-empty-text">Loading...</p>
                ) : serverDMs.length === 0 ? (
                  <div className="welcome__dashboard-empty">
                    <p className="welcome__dashboard-empty-text">No recent conversations</p>
                    <p className="welcome__dashboard-empty-sub">Join a server to start chatting</p>
                  </div>
                ) : (
                  serverDMs.map((sd) => (
                    <div key={sd.serverId} style={{ marginBottom: sd.channels.length > 0 ? '12px' : '0' }}>
                      <p className="welcome__dm-group-label">{sd.serverName}</p>
                      {sd.channels.map((ch) => (
                        <div key={ch.id} className="welcome__dm-item">
                          <div className="welcome__dm-avatar">{ch.other_display_name?.[0]?.toUpperCase()}</div>
                          <div>
                            <p className="welcome__dm-name">{ch.other_display_name}</p>
                            <p className="welcome__dm-username">@{ch.other_username}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="welcome__dashboard-panel">
              <div className="welcome__dashboard-panel-header">
                <span className="welcome__dashboard-panel-label">Server Status</span>
              </div>
              <div className="welcome__dashboard-panel-body">
                {servers.length === 0 ? (
                  <div className="welcome__dashboard-empty">
                    <p className="welcome__dashboard-empty-text">No servers to check</p>
                  </div>
                ) : (
                  servers.map((server) => {
                    const status = serverStatus[server.id] ?? 'checking'
                    return (
                      <div key={server.id} className="welcome__status-row">
                        <span className="welcome__status-label">{server.name}</span>
                        <span
                          className={`welcome__status-value ${
                            status === 'online' ? 'welcome__status-value--good' : status === 'offline' ? 'welcome__status-value--danger' : ''
                          }`}
                        >
                          {status === 'checking' ? 'Checking…' : status === 'online' ? 'Online' : 'Offline'}
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div className="welcome__dashboard-panel">
              <div className="welcome__dashboard-panel-header">
                <span className="welcome__dashboard-panel-label">About</span>
              </div>
              <div className="welcome__dashboard-panel-body">
                <p className="welcome__server-name">Kizuna {appVersion && <span className="welcome__dashboard-panel-label">v{appVersion}</span>}</p>
                <p className="welcome__subtitle" style={{ marginTop: '4px' }}>Self-hosted voice & chat</p>
                <div className="welcome__about-links">
                  <a href="https://itsashn.github.io/kizuna/" target="_blank" rel="noopener noreferrer" className="welcome__about-link">
                    <BookOpen size={14} />
                    Docs
                  </a>
                  <a href="https://github.com/ItsAshn/kizuna" target="_blank" rel="noopener noreferrer" className="welcome__about-link">
                    <GitBranch size={14} />
                    GitHub
                  </a>
                  <a href="https://github.com/ItsAshn/kizuna/issues" target="_blank" rel="noopener noreferrer" className="welcome__about-link">
                    <Bug size={14} />
                    Report Issue
                  </a>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <button className="welcome__dashboard-cta" onClick={() => setShowConnect(true)}>Connect to Server</button>
        </>
      )}

      <button
        className="welcome__settings-btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        <Settings size={18} />
      </button>
    </div>
  )
}
