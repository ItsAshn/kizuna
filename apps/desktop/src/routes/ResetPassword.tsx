import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useServerStore } from '../store/serverStore'
import { requestPasswordReset, validateResetToken, resetPassword, getAdminList } from '@kizuna/shared'
import type { AdminInfo } from '@kizuna/shared'
import '../styles/login.css'

type Phase = 'request' | 'token' | 'reset' | 'done'

export default function ResetPassword() {
  const { serverId } = useParams()
  const navigate = useNavigate()
  const { servers } = useServerStore()
  const server = servers.find((s) => s.id === serverId)

  const [phase, setPhase] = useState<Phase>('request')
  const [username, setUsername] = useState('')
  const [token, setToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [adminList, setAdminList] = useState<AdminInfo[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState('')
  const [validatedUsername, setValidatedUsername] = useState('')

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
      setSuccess('Reset request sent. An admin will provide you a reset token. Enter it below.')
      setPhase('token')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Request failed')
    }
    setLoading(false)
  }

  async function handleValidateToken(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim()) return
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      const res = await validateResetToken(server!.url, token.trim())
      setValidatedUsername(res.username)
      setPhase('reset')
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
      await resetPassword(server!.url, token.trim(), newPassword)
      setPhase('done')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to reset password')
    }
    setLoading(false)
  }

  return (
    <div className="login">
      <div className="login__card">
        <h2 className="auth-form__server-name">{server.name}</h2>

        {phase === 'request' && (
          <form onSubmit={handleRequestReset} noValidate>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Enter your username to request a password reset. A server admin will provide you a reset token.
            </p>
            <input
              className="input-field auth-form__input-spacer"
              placeholder="Username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <button
              type="submit"
              className="btn-primary"
              style={{ width: '100%' }}
              disabled={loading || !username.trim()}
            >
              {loading ? 'Requesting...' : 'Request Password Reset'}
            </button>

            {adminList.length > 0 && (
              <div style={{ marginTop: '16px' }}>
                <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '8px' }}>Server admins:</p>
                {adminList.map((admin) => (
                  <span key={admin.username} style={{ display: 'inline-block', marginRight: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                    @{admin.username}
                  </span>
                ))}
              </div>
            )}

            <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '12px' }}>
              Already have a token?{' '}
              <button type="button" onClick={() => setPhase('token')} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '12px', padding: 0 }}>
                Enter it here
              </button>
            </p>

            <button type="button" className="auth-form__back-btn" onClick={() => navigate('/')}>
              Back to servers
            </button>

            {error && <p className="auth-form__error">{error}</p>}
            {success && <p style={{ marginTop: '16px', color: 'var(--green)', fontSize: '13px', textAlign: 'center' }}>{success}</p>}
          </form>
        )}

        {phase === 'token' && (
          <form onSubmit={handleValidateToken} noValidate>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Enter the reset token provided by a server admin.
            </p>
            <input
              className="input-field auth-form__input-spacer"
              placeholder="Reset token"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              type="submit"
              className="btn-primary"
              style={{ width: '100%' }}
              disabled={loading || !token.trim()}
            >
              {loading ? 'Validating...' : 'Continue'}
            </button>

            <button type="button" className="auth-form__back-btn" onClick={() => { setPhase('request'); setError('') }}>
              Back
            </button>

            {error && <p className="auth-form__error">{error}</p>}
            {success && <p style={{ marginTop: '16px', color: 'var(--green)', fontSize: '13px', textAlign: 'center' }}>{success}</p>}
          </form>
        )}

        {phase === 'reset' && (
          <form onSubmit={handleSetPassword} noValidate>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Set a new password for <strong>{validatedUsername}</strong>.
            </p>
            <input
              className="input-field auth-form__input-spacer"
              type="password"
              placeholder="New password (min 8 characters)"
              autoComplete="new-password"
              autoFocus
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
              disabled={loading || !newPassword || !confirmPassword}
            >
              {loading ? 'Setting password...' : 'Set New Password'}
            </button>

            <button type="button" className="auth-form__back-btn" onClick={() => { setPhase('token'); setError('') }}>
              Back
            </button>

            {error && <p className="auth-form__error">{error}</p>}
          </form>
        )}

        {phase === 'done' && (
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
