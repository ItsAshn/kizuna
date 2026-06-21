import { useState } from 'react'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import './AuthForm.css'

interface AuthFormProps {
  serverName: string
  serverUrl: string
  serverIcon?: string | null
  serverDescription?: string
  isRegister: boolean
  setIsRegister: (v: boolean) => void
  username: string
  setUsername: (v: string) => void
  password: string
  setPassword: (v: string) => void
  displayName: string
  setDisplayName: (v: string) => void
  serverPassword: string
  setServerPassword: (v: string) => void
  serverPasswordProtected: boolean
  error: string
  loading: boolean
  onSubmit: () => void
  onBack: () => void
  backLabel: string
  onForgotPassword?: () => void
}

export default function AuthForm({
  serverName,
  serverUrl,
  serverIcon,
  serverDescription,
  isRegister,
  setIsRegister,
  username,
  setUsername,
  password,
  setPassword,
  displayName,
  setDisplayName,
  serverPassword,
  setServerPassword,
  serverPasswordProtected,
  error,
  loading,
  onSubmit,
  onBack,
  backLabel,
  onForgotPassword,
}: AuthFormProps) {
  const [showPassword, setShowPassword] = useState(false)
  const [showServerPassword, setShowServerPassword] = useState(false)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password.trim() || loading) return
    onSubmit()
  }

  return (
    <>
      <div className="auth-form__server-header">
        {serverIcon ? (
          <img src={serverIcon} alt="" className="auth-form__server-icon" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        ) : (
          <div className="auth-form__server-icon auth-form__server-icon--fallback">
            {serverName.slice(0, 2).toUpperCase()}
          </div>
        )}
        <h2 className="auth-form__server-name">{serverName}</h2>
        {serverDescription && <p className="auth-form__server-description">{serverDescription}</p>}
        <p className="auth-form__server-url">{serverUrl}</p>
      </div>

      <div className="auth-form__tabs">
        <button
          type="button"
          className={`auth-form__tab ${!isRegister ? 'auth-form__tab--active' : ''}`}
          onClick={() => setIsRegister(false)}
        >
          Sign In
        </button>
        <button
          type="button"
          className={`auth-form__tab ${isRegister ? 'auth-form__tab--active' : ''}`}
          onClick={() => setIsRegister(true)}
        >
          Register
        </button>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <input
          className="input-field auth-form__input-spacer"
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <div className="password-input-wrapper auth-form__input-spacer">
          <input
            className="input-field password-input-wrapper__input"
            type={showPassword ? 'text' : 'password'}
            placeholder="Password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="password-input-wrapper__toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {isRegister && (
          <>
            <input
              className="input-field auth-form__input-spacer"
              placeholder="Display name (optional)"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            {serverPasswordProtected && (
              <div className="password-input-wrapper auth-form__input-spacer">
                <input
                  className="input-field password-input-wrapper__input"
                  type={showServerPassword ? 'text' : 'password'}
                  placeholder="Server password"
                  autoComplete="off"
                  value={serverPassword}
                  onChange={(e) => setServerPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="password-input-wrapper__toggle"
                  onClick={() => setShowServerPassword((v) => !v)}
                  aria-label={showServerPassword ? 'Hide password' : 'Show password'}
                >
                  {showServerPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            )}
          </>
        )}

        <button
          type="submit"
          className="btn-primary"
          style={{ width: '100%' }}
          disabled={loading || !username.trim() || !password.trim()}
        >
          {loading && <Loader2 size={16} className="spinner-icon" />}
          {loading ? 'Please wait...' : isRegister ? 'Create Account' : 'Sign In'}
        </button>

        {!isRegister && onForgotPassword && (
          <button type="button" className="auth-form__forgot-btn" onClick={onForgotPassword}>
            Forgot password?
          </button>
        )}

        <button type="button" className="auth-form__back-btn" onClick={onBack}>
          {backLabel}
        </button>

        {error && <p className="auth-form__error">{error}</p>}
      </form>
    </>
  )
}
