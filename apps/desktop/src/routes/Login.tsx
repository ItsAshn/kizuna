import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { login, register, fetchServerInfo, uploadPublicKey } from '@kizuna/shared'
import { generateAndStoreKey, initializeCrypto, userNeedsKeyUpload, getPublicKey } from '../store/keyStore'
import '../styles/login.css'

export default function Login() {
  const { serverId } = useParams()
  const navigate = useNavigate()
  const { servers, setActiveSession } = useServerStore()
  const server = servers.find((s) => s.id === serverId)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [serverInfo, setServerInfo] = useState<any>(null)

  useEffect(() => {
    if (server) {
      fetchServerInfo(server.url)
        .then(setServerInfo)
        .catch(() => setError('Could not reach server'))
    }
  }, [server])

  if (!server) {
    return (
      <div className="login__not-found">
        <div>
          <p className="login__not-found-text">Server not found</p>
          <button className="btn-primary" onClick={() => navigate('/')}>Go back</button>
        </div>
      </div>
    )
  }

  async function handleAuth() {
    if (!username.trim() || !password.trim()) return
    setLoading(true)
    setError('')
    try {
      let result
      if (isRegister) {
        const pubKey = await generateAndStoreKey(server!.url, password)
        result = await register(server!.url, username.trim(), password, displayName || username, serverPassword || undefined, pubKey)
      } else {
        result = await login(server!.url, username.trim(), password)
        await initializeCrypto(server!.url, result.token, password)
        if (userNeedsKeyUpload(result.user.public_key, server!.url)) {
          const pk = getPublicKey()
          if (pk) await uploadPublicKey(server!.url, result.token, pk)
        }
      }

      setActiveSession({
        serverId: server!.id,
        url: server!.url,
        token: result.token,
        user: result.user,
      })

      navigate('/chat')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed')
    }
    setLoading(false)
  }

  return (
    <div className="login">
      <div className="login__card">
        <h2 className="login__server-name">{serverInfo?.name || server.name}</h2>
        <p className="login__server-url">{server.url}</p>

        <div className="login__tabs">
          <button
            className={`login__tab ${!isRegister ? 'login__tab--active' : ''}`}
            onClick={() => setIsRegister(false)}
          >
            Sign In
          </button>
          <button
            className={`login__tab ${isRegister ? 'login__tab--active' : ''}`}
            onClick={() => setIsRegister(true)}
          >
            Register
          </button>
        </div>

        <input className="input-field login__input-spacer" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input className="input-field login__input-spacer" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleAuth()} />
        {isRegister && (
          <>
            <input className="input-field login__input-spacer" placeholder="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            {serverInfo?.passwordProtected && (
              <input className="input-field login__input-spacer" type="password" placeholder="Server password" value={serverPassword} onChange={(e) => setServerPassword(e.target.value)} />
            )}
          </>
        )}

        <button
          className="btn-primary"
          style={{ width: '100%' }}
          onClick={handleAuth}
          disabled={loading || !username.trim() || !password.trim()}
        >
          {loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}
        </button>

        <button className="login__back-btn" onClick={() => navigate('/')}>
          Back to servers
        </button>

        {error && <p className="login__error">{error}</p>}
      </div>
    </div>
  )
}
