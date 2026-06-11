import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { login, register, fetchServerInfo, uploadPublicKey, getChallenge } from '@kizuna/shared'
import { solvePoW } from '@kizuna/shared/pow'
import { generateAndStoreKey, initializeCrypto, userNeedsKeyUpload, getPublicKey } from '../store/keyStore'
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
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [serverInfo, setServerInfo] = useState<any>(null)
  const [showBackupToken, setShowBackupToken] = useState<string | null>(null)

  useEffect(() => {
    if (serverUrl) {
      fetchServerInfo(serverUrl)
        .then(setServerInfo)
        .catch(() => setError('Could not reach server'))
    }
  }, [serverUrl])

  async function handleAuth() {
    if (!username.trim() || !password.trim()) return
    setLoading(true)
    setError('')
    try {
      let result
      if (isRegister) {
        const { challenge, difficulty } = await getChallenge(serverUrl)
        const { nonce } = await solvePoW(challenge, difficulty)
        const pubKey = await generateAndStoreKey(serverUrl, password)
        result = await register(serverUrl, username.trim(), password, displayName || username, serverPassword || undefined, pubKey, challenge, nonce)

        setActiveSession({
          serverId: serverUrl,
          url: serverUrl,
          token: result.token,
          user: result.user,
        })

        if (result.backuptoken) {
          setShowBackupToken(result.backuptoken)
          setLoading(false)
          return
        }
      } else {
        result = await login(serverUrl, username.trim(), password)
        await initializeCrypto(serverUrl, result.token, password)
        if (userNeedsKeyUpload(result.user.public_key, serverUrl)) {
          const pk = getPublicKey()
          if (pk) await uploadPublicKey(serverUrl, result.token, pk)
        }

        setActiveSession({
          serverId: serverUrl,
          url: serverUrl,
          token: result.token,
          user: result.user,
        })
      }

      onClose()
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
        className="login-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="login-dialog__header">
          <span className="login-dialog__header-title">// login</span>
          <button onClick={onClose} className="login-dialog__close-btn">[esc]</button>
        </div>
        <div className="login-dialog__body">
          <AuthForm
            serverName={serverInfo?.name || server?.name || serverUrl}
            serverUrl={serverUrl}
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
        </div>
      </div>
    </div>
  )
}
