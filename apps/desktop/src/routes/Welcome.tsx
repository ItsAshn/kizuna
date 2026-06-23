import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { fetchDMChannels, fetchServerInfo, resolveInviteCode } from '@kizuna/shared'
import { useAuth } from '../hooks/useAuth'
import { useMobile } from '../hooks/useMobile'
import type { DMChannelData } from '@kizuna/shared'
import { Settings } from 'lucide-react'
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
  const [serverDMs, setServerDMs] = useState<ServerDMs[]>([])
  const [dmsLoading, setDmsLoading] = useState(false)

  const [showLanding, setShowLanding] = useState(() => {
    return isLanding && localStorage.getItem('kizuna-landing-dismissed') !== 'true'
  })
  const [showConnect, setShowConnect] = useState(false)
  const [serverUrl, setServerUrl] = useState('')
  const [serverInfo, setServerInfo] = useState<any>(null)

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
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Could not reach server. Check the URL or invite code and try again.')
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
    if (!success) return

    const id = serverUrl.trim()
    addServer({
      id,
      name: serverInfo?.name || serverUrl,
      url: id,
      icon: serverInfo?.icon || undefined,
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

  const totalMentions = Object.values(mentionCounts).reduce((sum, n) => sum + n, 0)

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
              serverName={serverInfo.name}
              serverUrl={serverUrl}
              serverIcon={serverInfo.icon}
              serverDescription={serverInfo.description}
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
              serverPasswordProtected={!!serverInfo.passwordProtected}
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
        {import.meta.env.DEV && (
          <button
            className="welcome__dev-toggle"
            onClick={() => setShowLanding((v) => !v)}
          >
            Show Landing Preview
          </button>
        )}
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
                <span className="welcome__dashboard-panel-label">Status</span>
              </div>
              <div className="welcome__dashboard-panel-body">
                <div className="welcome__status-row">
                  <span className="welcome__status-label">Servers</span>
                  <span className="welcome__status-value">{servers.length}</span>
                </div>
                {totalMentions > 0 && (
                  <div className="welcome__status-row">
                    <span className="welcome__status-label">Mentions</span>
                    <span className="welcome__status-value welcome__status-value--danger">{totalMentions}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="welcome__dashboard-panel">
              <div className="welcome__dashboard-panel-header">
                <span className="welcome__dashboard-panel-label">About</span>
              </div>
              <div className="welcome__dashboard-panel-body">
                <p className="welcome__server-name">Kizuna <span className="welcome__dashboard-panel-label">v0.1.0</span></p>
                <p className="welcome__subtitle" style={{ marginTop: '4px' }}>Self-hosted voice & chat</p>
                <div className="welcome__tech-tags">
                  <span className="welcome__tech-tag">webrtc</span>
                  <span className="welcome__tech-tag">mediasoup</span>
                  <span className="welcome__tech-tag">react</span>
                  <span className="welcome__tech-tag">sqlite</span>
                  <span className="welcome__tech-tag">tauri</span>
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
