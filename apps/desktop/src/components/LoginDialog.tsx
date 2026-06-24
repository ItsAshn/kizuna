import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { fetchServerInfo } from '@kizuna/shared'
import type { ServerInfo } from '@kizuna/shared'
import { useAuth } from '../hooks/useAuth'
import Modal from './ui/Modal'
import AuthForm from './AuthForm'
import BackupTokenModal from './BackupTokenModal'
import './LoginDialog.css'

interface Props {
  serverId: string
  onClose: () => void
}

export default function LoginDialog({ serverId, onClose }: Props) {
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
      onClose()
    }
  }

  return (
    <Modal open onClose={onClose} title="// login" className="login-dialog">
      {backupToken && (
        <BackupTokenModal
          backuptoken={backupToken}
          onComplete={() => {
            clearBackupToken()
            onClose()
          }}
        />
      )}
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
        onBack={onClose}
        backLabel="Cancel"
        onForgotPassword={() => navigate(`/reset-password/${encodeURIComponent(serverUrl)}`)}
      />
    </Modal>
  )
}
