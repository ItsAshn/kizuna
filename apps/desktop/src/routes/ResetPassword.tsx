import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { requestPasswordReset, validateResetToken, resetPassword, resetWithBackupToken, getAdminList } from '@kizuna/shared'
import type { AdminInfo } from '@kizuna/shared'
import BackupTokenModal from '../components/BackupTokenModal'
import '../styles/login.css'

type Phase = 'username' | 'choice' | 'adminToken' | 'newPassword' | 'done'
type ResetMethod = 'backuptoken' | 'admin' | null

export default function ResetPassword() {
  const { serverId } = useParams()
  const navigate = useNavigate()
  const { servers } = useServerStore()
  const server = servers.find((s) => s.id === serverId)

  const [phase, setPhase] = useState<Phase>('username')
  const [resetMethod, setResetMethod] = useState<ResetMethod>(null)
  const [username, setUsername] = useState('')
  const [backuptoken, setBackuptoken] = useState('')
  const [adminToken, setAdminToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [adminList, setAdminList] = useState<AdminInfo[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [validatedUsername, setValidatedUsername] = useState('')
  const [newBackupToken, setNewBackupToken] = useState<string | null>(null)

  useEffect(() => {
    if (server) {
      getAdminList(server.url)
        .then(setAdminList)
        .catch(() => {})
    }
  }, [server])

  if (!server) {
    return (
      <div className="login">
        <div className="login__card">
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', marginBottom: '12px' }}>Server not found</p>
          <button className="btn-primary" style={{ width: '100%' }} onClick={() => navigate('/')}>Go back</button>
        </div>
      </div>
    )
  }

  async function handleRequestReset(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) return
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      await requestPasswordReset(server!.url, username.trim())
      setPhase('choice')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Request failed')
    }
    setLoading(false)
  }

  async function handleBackupTokenSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!backuptoken.trim() || !newPassword || !confirmPassword) return
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = await resetWithBackupToken(server!.url, username.trim(), backuptoken.trim(), newPassword)
      setNewBackupToken(result.backuptoken)
      setPhase('done')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to reset password')
    }
    setLoading(false)
  }

  async function handleAdminTokenSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!adminToken.trim()) return
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const res = await validateResetToken(server!.url, adminToken.trim())
      setValidatedUsername(res.username)
      setResetMethod('admin')
      setPhase('newPassword')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Invalid or expired token')
    }
    setLoading(false)
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!newPassword || !confirmPassword) return
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = resetMethod === 'admin'
        ? await resetPassword(server!.url, adminToken.trim(), newPassword)
        : await resetWithBackupToken(server!.url, validatedUsername || username.trim(), backuptoken.trim(), newPassword)

      setNewBackupToken(result.backuptoken)
      setPhase('done')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to reset password')
    }
    setLoading(false)
  }

  return (
    <div className="login">
      {newBackupToken && phase === 'done' && (
        <BackupTokenModal
          backuptoken={newBackupToken}
          onComplete={() => setNewBackupToken(null)}
        />
      )}
      <div className="login__card">
        <h2 className="auth-form__server-name">{server.name}</h2>

        {phase === 'username' && (
          <form onSubmit={handleRequestReset} noValidate>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Enter your username to begin password recovery.
            </p>
            <input
              className="input-field auth-form__input-spacer"
              placeholder="Username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />

            {adminList.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>Server admins:</p>
                {adminList.map((admin) => (
                  <span key={admin.username} style={{ display: 'inline-block', marginRight: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                    @{admin.username}
                  </span>
                ))}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary"
              style={{ width: '100%' }}
              disabled={loading || !username.trim()}
            >
              {loading ? 'Checking...' : 'Continue'}
            </button>

            <button type="button" className="auth-form__back-btn" onClick={() => navigate('/')}>
              Back to servers
            </button>

            {error && <p className="auth-form__error">{error}</p>}
            {success && <p style={{ marginTop: '16px', color: 'var(--green)', fontSize: '13px', textAlign: 'center' }}>{success}</p>}
          </form>
        )}

        {phase === 'choice' && (
          <div>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              How would you like to recover your account?
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <button
                className="btn-primary"
                onClick={() => {
                  setResetMethod('backuptoken')
                  setPhase('newPassword')
                }}
              >
                I have my backup token
              </button>

              <button
                className="btn-secondary"
                onClick={() => {
                  setResetMethod('admin')
                  setPhase('adminToken')
                }}
              >
                I lost my backup token — I need an admin
              </button>
            </div>

            <button type="button" className="auth-form__back-btn" onClick={() => { setPhase('username'); setError('') }}>
              Back
            </button>
          </div>
        )}

        {phase === 'adminToken' && (
          <form onSubmit={handleAdminTokenSubmit} noValidate>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px', lineHeight: '1.5' }}>
              To reset your password, you need a reset token from a server admin.
              Contact one of the admins listed below and ask them to generate a password reset token for you.
            </p>

            {adminList.length > 0 && (
              <div style={{ marginBottom: '12px', padding: '8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)' }}>
                <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' }}>Server admins:</p>
                {adminList.map((admin) => (
                  <span key={admin.username} style={{ display: 'inline-block', marginRight: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                    @{admin.username}
                  </span>
                ))}
              </div>
            )}

            <input
              className="input-field auth-form__input-spacer"
              placeholder="Enter reset token from admin"
              autoFocus
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
            />
            <button
              type="submit"
              className="btn-primary"
              style={{ width: '100%' }}
              disabled={loading || !adminToken.trim()}
            >
              {loading ? 'Validating...' : 'Continue'}
            </button>

            <button type="button" className="auth-form__back-btn" onClick={() => { setPhase('choice'); setError('') }}>
              Back
            </button>

            {error && <p className="auth-form__error">{error}</p>}
          </form>
        )}

        {phase === 'newPassword' && (
          <form onSubmit={resetMethod === 'backuptoken' ? handleBackupTokenSubmit : handleSetPassword} noValidate>
            {resetMethod === 'backuptoken' && (
              <>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
                  Enter your backup token and new password to reset your account for <strong>{username}</strong>.
                </p>
                <input
                  className="input-field auth-form__input-spacer"
                  placeholder="Backup token"
                  autoFocus
                  value={backuptoken}
                  onChange={(e) => setBackuptoken(e.target.value)}
                />
              </>
            )}

            {resetMethod === 'admin' && (
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
                Set a new password for <strong>{validatedUsername}</strong>.
              </p>
            )}

            <input
              className="input-field auth-form__input-spacer"
              type="password"
              placeholder="New password (min 8 characters)"
              autoComplete="new-password"
              autoFocus={resetMethod !== 'backuptoken'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <input
              className="input-field auth-form__input-spacer"
              type="password"
              placeholder="Confirm new password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
            <button
              type="submit"
              className="btn-primary"
              style={{ width: '100%' }}
              disabled={loading || (resetMethod === 'backuptoken' ? (!backuptoken.trim() || !newPassword || !confirmPassword) : (!newPassword || !confirmPassword))}
            >
              {loading ? 'Setting password...' : 'Set New Password'}
            </button>

            <button type="button" className="auth-form__back-btn" onClick={() => { setPhase(resetMethod === 'admin' ? 'adminToken' : 'choice'); setError('') }}>
              Back
            </button>

            {error && <p className="auth-form__error">{error}</p>}
          </form>
        )}

        {phase === 'done' && !newBackupToken && (
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--green)', fontSize: '14px', marginBottom: '16px' }}>
              Password reset successfully.
            </p>
            <button
              className="btn-primary"
              style={{ width: '100%' }}
              onClick={() => navigate(`/login/${server.id}`)}
            >
              Go to Login
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
