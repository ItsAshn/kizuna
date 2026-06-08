import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { fetchServerInfo, login, register, fetchDMChannels, resolveInviteCode, uploadPublicKey } from '@kizuna/shared'
import { generateAndStoreKey, initializeCrypto, userNeedsKeyUpload, getPublicKey } from '../store/keyStore'
import type { DMChannelData } from '@kizuna/shared'
import AuthForm from '../components/AuthForm'
import Landing from './Landing'
import '../styles/welcome.css'

const INVITE_CODE_RE = /^[A-Za-z0-9+\-_=]+\.[A-Za-z0-9+\-_=]+$/

function isInviteCode(input: string): boolean {
  return INVITE_CODE_RE.test(input.trim())
}

interface ServerDMs {
  serverId: string
  serverName: string
  channels: DMChannelData[]
}

export default function Welcome({ isLanding = false }: { isLanding?: boolean }) {
  const navigate = useNavigate()
  const { addServer, setActiveSession, servers } = useServerStore()
  const mentionCounts = useChatStore((s) => s.mentionCounts)
  const [serverDMs, setServerDMs] = useState<ServerDMs[]>([])
  const [dmsLoading, setDmsLoading] = useState(false)

  const [showLanding, setShowLanding] = useState(isLanding)
  const [showConnect, setShowConnect] = useState(false)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [serverInfo, setServerInfo] = useState<any>(null)
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    async function loadDMs() {
      if (servers.length === 0) { setServerDMs([]); return }
      setDmsLoading(true)
      const results: ServerDMs[] = []
      for (const server of servers) {
        try {
          const channels = await fetchDMChannels(server.url, '')
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
    setConnecting(true)
    setError('')
    try {
      if (isInviteCode(urlToUse)) {
        const resolved = await resolveInviteCode(urlToUse.trim())
        setServerInfo(resolved)
        setUrl(resolved.serverUrl)
      } else {
        const info = await fetchServerInfo(urlToUse.trim())
        setServerInfo(info)
        setUrl(urlToUse.trim())
      }
      setShowConnect(true)
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Could not reach server. Check the URL or invite code and try again.')
    }
    setConnecting(false)
  }

  async function handleAuth() {
    if (!username.trim() || !password.trim()) return
    setLoading(true)
    setError('')
    try {
      let result
      if (isRegister) {
        const pubKey = await generateAndStoreKey(url.trim(), password)
        result = await register(url.trim(), username.trim(), password, displayName || username, serverPassword || undefined, pubKey)
      } else {
        result = await login(url.trim(), username.trim(), password)
        await initializeCrypto(url.trim(), result.token, password)
        if (userNeedsKeyUpload(result.user.public_key, url.trim())) {
          const pk = getPublicKey()
          if (pk) await uploadPublicKey(url.trim(), result.token, pk)
        }
      }

      const serverId = url.trim()
      addServer({
        id: serverId,
        name: serverInfo?.name || url,
        url: serverId,
        icon: serverInfo?.icon || undefined,
        addedAt: Date.now(),
      })

      setActiveSession({
        serverId,
        url: serverId,
        token: result.token,
        user: result.user,
      })

      navigate('/chat')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed')
    }
    setLoading(false)
  }

  const totalMentions = Object.values(mentionCounts).reduce((sum, n) => sum + n, 0)

  if (showConnect && serverInfo) {
    return (
      <div className="welcome">
        <div className="welcome__container">
          <div className="welcome__branding">
            <img src="/Logo.svg" alt="Kizuna" className="welcome__logo" />
            <h1 className="welcome__title">Kizuna</h1>
            <p className="welcome__subtitle">Self-hosted voice & chat</p>
          </div>

          <div className="welcome__card">
            <AuthForm
              serverName={serverInfo.name}
              serverUrl={url}
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
              onBack={() => { setShowConnect(false); setServerInfo(null); setError('') }}
              backLabel="Back to Dashboard"
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
            <input className="input-field welcome__input-spacer" placeholder="Server URL or invite code..." value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleConnect(url)} />
            <button className="btn-primary" style={{ width: '100%' }} onClick={() => handleConnect(url)} disabled={connecting || !url.trim()}>
              {connecting ? 'Connecting...' : 'Connect'}
            </button>

            {servers.length > 0 && (
              <div>
                <h3 className="welcome__saved-header">Saved Servers</h3>
                {servers.map((server) => (
                  <button key={server.id} className="welcome__saved-server" onClick={() => handleConnect(server.url)}>
                    {server.name}
                    <span className="welcome__saved-server-url">{server.url}</span>
                  </button>
                ))}
              </div>
            )}

            <button className="welcome__back-btn" onClick={() => { setShowConnect(false); setError('') }}>Back to Dashboard</button>
            {error && <p className="welcome__error">{error}</p>}
          </div>
        </div>
      </div>
    )
  }

  if (showLanding) {
    return <Landing onConnect={handleConnect} onEnterApp={() => setShowLanding(false)} />
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
      </div>

      <button className="welcome__dashboard-cta" onClick={() => setShowConnect(true)}>Connect to Server</button>
    </div>
  )
}
