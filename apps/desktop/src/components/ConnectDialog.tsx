import { useState, useEffect } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { login, register, fetchServerInfo, uploadPublicKey, getChallenge, resolveInviteCode } from '@kizuna/shared'
import { solvePoW } from '@kizuna/shared/pow'
import { generateAndStoreKey, initializeCrypto, userNeedsKeyUpload } from '../store/keyStore'
import AuthForm from './AuthForm'
import BackupTokenModal from './BackupTokenModal'
import './LoginDialog.css'
import './ConnectDialog.css'

const INVITE_CODE_RE = /^[A-Za-z0-9+\-_=]+\.[A-Za-z0-9+\-_=]+$/

function isInviteCode(input: string): boolean {
  return INVITE_CODE_RE.test(input.trim())
}

interface Props {
  onClose: () => void
}

export default function ConnectDialog({ onClose }: Props) {
  const { addServer, setActiveSession, servers } = useServerStore()
  const mentionCounts = useChatStore((s) => s.mentionCounts)

  const [url, setUrl] = useState('')
  const [serverInfo, setServerInfo] = useState<any>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showBackupToken, setShowBackupToken] = useState<string | null>(null)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function handleConnect(urlToUse: string) {
    if (!urlToUse.trim()) return
    setConnecting(true)
    setError('')
    try {
      let resolvedUrl: string
      if (isInviteCode(urlToUse)) {
        const resolved = await resolveInviteCode(urlToUse.trim())
        setServerInfo(resolved)
        resolvedUrl = resolved.serverUrl
      } else {
        const info = await fetchServerInfo(urlToUse.trim())
        setServerInfo(info)
        resolvedUrl = urlToUse.trim()
      }
      setUrl(resolvedUrl)
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
        const { challenge, difficulty } = await getChallenge(url.trim())
        const { nonce } = await solvePoW(challenge, difficulty)
        const { publicKey, salt } = await generateAndStoreKey(url.trim(), password)
        result = await register(url.trim(), username.trim(), password, displayName || username, serverPassword || undefined, publicKey, JSON.stringify(salt), challenge, nonce)

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

        if (result.backuptoken) {
          setShowBackupToken(result.backuptoken)
          setLoading(false)
          return
        }

        onClose()
        return
      } else {
        result = await login(url.trim(), username.trim(), password)
        const serverSalt = result.user.key_salt ? JSON.parse(result.user.key_salt) : null
        const { publicKey, salt } = await initializeCrypto(url.trim(), password, serverSalt, result.user.public_key)
        if (userNeedsKeyUpload(result.user.public_key, url.trim())) {
          await uploadPublicKey(url.trim(), publicKey, salt)
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

        onClose()
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed')
    }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      {showBackupToken && (
        <BackupTokenModal
          backuptoken={showBackupToken}
          onComplete={onClose}
        />
      )}
      <div
        className="login-dialog connect-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="login-dialog__header">
          <span className="login-dialog__header-title">// add server</span>
          <button onClick={onClose} className="login-dialog__close-btn">[esc]</button>
        </div>
        <div className="login-dialog__body">
          {!serverInfo ? (
            <div className="connect-dialog__connect">
              <input
                className="input-field connect-dialog__input"
                placeholder="Server URL or invite code..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect(url)}
                autoFocus
              />
              <button
                className="btn-primary"
                style={{ width: '100%' }}
                onClick={() => handleConnect(url)}
                disabled={connecting || !url.trim()}
              >
                {connecting ? 'Connecting...' : 'Connect'}
              </button>

              {servers.length > 0 && (
                <div>
                  <h3 className="connect-dialog__saved-header">Saved Servers</h3>
                  {servers.map((server) => (
                    <button
                      key={server.id}
                      className="connect-dialog__saved-server"
                      onClick={() => handleConnect(server.url)}
                    >
                      <span className="connect-dialog__saved-server-info">
                        {server.name}
                        <span className="connect-dialog__saved-server-url">{server.url}</span>
                      </span>
                      {(mentionCounts[server.id] ?? 0) > 0 && (
                        <span className="sidebar__unread-badge">
                          {mentionCounts[server.id] > 99 ? '99+' : mentionCounts[server.id]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {error && <p className="auth-form__error">{error}</p>}
            </div>
          ) : (
            <AuthForm
              serverName={serverInfo.name}
              serverUrl={url}
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
              onBack={() => { setServerInfo(null); setError('') }}
              backLabel="Back to URL entry"
            />
          )}
        </div>
      </div>
    </div>
  )
}
