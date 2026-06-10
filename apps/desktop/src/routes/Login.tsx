import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { login, register, fetchServerInfo, uploadPublicKey, getChallenge } from '@kizuna/shared'
import { solvePoW } from '@kizuna/shared/pow'
import { generateAndStoreKey, initializeCrypto, userNeedsKeyUpload, getPublicKey } from '../store/keyStore'
import AuthForm from '../components/AuthForm'
import BackupTokenModal from '../components/BackupTokenModal'
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
  const [showBackupToken, setShowBackupToken] = useState<string | null>(null)

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
        const { challenge, difficulty } = await getChallenge(server!.url)
        const { nonce } = await solvePoW(challenge, difficulty)
        const pubKey = await generateAndStoreKey(server!.url, password)
        result = await register(server!.url, username.trim(), password, displayName || username, serverPassword || undefined, pubKey, challenge, nonce)

        setActiveSession({
          serverId: server!.id,
          url: server!.url,
          token: result.token,
          user: result.user,
        })

        if (result.backuptoken) {
          setShowBackupToken(result.backuptoken)
          setLoading(false)
          return
        }
      } else {
        result = await login(server!.url, username.trim(), password)
        await initializeCrypto(server!.url, result.token, password)
        if (userNeedsKeyUpload(result.user.public_key, server!.url)) {
          const pk = getPublicKey()
          if (pk) await uploadPublicKey(server!.url, result.token, pk)
        }

        setActiveSession({
          serverId: server!.id,
          url: server!.url,
          token: result.token,
          user: result.user,
        })
      }

      navigate('/chat')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed')
    }
    setLoading(false)
  }

  return (
    <div className="login">
      {showBackupToken && (
        <BackupTokenModal
          backuptoken={showBackupToken}
          onComplete={() => navigate('/chat')}
        />
      )}
      <div className="login__card">
        <AuthForm
          serverName={serverInfo?.name || server.name}
          serverUrl={server.url}
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
          serverPasswordProtected={!!serverInfo?.passwordProtected}
          error={error}
          loading={loading}
          onSubmit={handleAuth}
          onBack={() => navigate('/')}
          backLabel="Back to servers"
          onForgotPassword={() => navigate(`/reset-password/${server.id}`)}
        />
      </div>
    </div>
  )
}
