import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { fetchServerInfo } from '@kizuna/shared'
import type { ServerInfo } from '@kizuna/shared'
import { useAuth } from '../hooks/useAuth'
import AuthForm from '../components/AuthForm'
import BackupTokenModal from '../components/BackupTokenModal'
import Button from '../components/ui/Button'
import './Login.css'

export default function Login() {
  const { serverId } = useParams()
  const navigate = useNavigate()
  const { servers, setActiveSession } = useServerStore()
  const server = servers.find((s) => s.id === serverId)
  const serverUrl = server?.url || serverId || ''

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)

  const { authenticate, loading, error, setError, backupToken, clearBackupToken } = useAuth(serverUrl)

  useEffect(() => {
    if (serverUrl) {
      fetchServerInfo(serverUrl)
        .then(setServerInfo)
        .catch(() => setError('Could not reach server'))
    }
  }, [serverUrl])

  if (!serverUrl) {
    return (
      <div className="login__not-found">
        <div>
          <p className="login__not-found-text">Server not found</p>
          <Button onClick={() => navigate('/')}>Go back</Button>
        </div>
      </div>
    )
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

    setActiveSession({
      serverId: serverUrl,
      url: serverUrl,
      token: result.token,
      user: result.user,
    })

    if (!result.backuptoken) {
      navigate('/chat')
    }
  }

  return (
    <div className="login">
      {backupToken && (
        <BackupTokenModal
          backuptoken={backupToken}
          onComplete={() => {
            clearBackupToken()
            navigate('/chat')
          }}
        />
      )}
      <div className="login__card">
        <AuthForm
          serverName={serverInfo?.name || server?.name || serverUrl}
          serverUrl={serverUrl}
          serverIcon={serverInfo?.icon}
          serverDescription={serverInfo?.description}
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
          onForgotPassword={() => navigate(`/reset-password/${encodeURIComponent(serverUrl)}`)}
        />
      </div>
    </div>
  )
}
