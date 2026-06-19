import { useState } from 'react'
import { useServerStore } from '../store/serverStore'
import { useAuth } from '../hooks/useAuth'
import Modal from './ui/Modal'
import AuthForm from './AuthForm'
import BackupTokenModal from './BackupTokenModal'
import ServerConnectForm from './ServerConnectForm'
import './ConnectDialog.css'

interface Props {
  onClose: () => void
}

export default function ConnectDialog({ onClose }: Props) {
  const { addServer, setActiveSession, servers } = useServerStore()

  const [serverUrl, setServerUrl] = useState('')
  const [serverInfo, setServerInfo] = useState<any>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [serverPassword, setServerPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)

  const { authenticate, loading, error, setError, backupToken, clearBackupToken } = useAuth(serverUrl)

  function handleServerConnect(resolvedUrl: string, info: any) {
    setServerUrl(resolvedUrl)
    setServerInfo(info)
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
      onClose()
    }
  }

  return (
    <Modal open onClose={onClose} title="// add server" className="connect-dialog">
      {backupToken && (
        <BackupTokenModal
          backuptoken={backupToken}
          onComplete={() => {
            clearBackupToken()
            onClose()
          }}
        />
      )}
      {!serverInfo ? (
        <ServerConnectForm
          onConnect={handleServerConnect}
          savedServers={servers.map((s) => ({ id: s.id, name: s.name, url: s.url }))}
        />
      ) : (
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
          onBack={() => {
            setServerInfo(null)
            setError('')
          }}
          backLabel="Back to URL entry"
        />
      )}
    </Modal>
  )
}
