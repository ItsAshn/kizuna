import { useEffect, useState } from 'react'
import './SetupWizard.css'

interface EnvIssue {
  severity: string
  component: string
  message: string
  fix_command: string | null
}

interface EnvDiagnostic {
  session_type: string
  compositor: string
  pipewire_ok: boolean
  pipewire_pulse_ok: boolean
  portal_ok: boolean
  portal_backend: string
  issues: EnvIssue[]
}

const STORAGE_KEY = 'kizuna-setup-wizard-dismissed'

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

function StatusIcon({ ok }: { ok: boolean }) {
  return <span className={`setup-wizard__status-icon ${ok ? 'setup-wizard__status-icon--ok' : 'setup-wizard__status-icon--fail'}`}>{ok ? 'OK' : '!'}</span>
}

export default function SetupWizard({ onClose }: { onClose: () => void }) {
  const [diagnostic, setDiagnostic] = useState<EnvDiagnostic | null>(null)
  const [loading, setLoading] = useState(true)
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false)
      return
    }
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<EnvDiagnostic>('get_environment'))
      .then(setDiagnostic)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  const handleCopy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopiedCmd(cmd)
      setTimeout(() => setCopiedCmd(null), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    onClose()
  }

  const handleDontShowAgain = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    onClose()
  }

  if (loading) {
    return (
      <div className="modal-overlay">
        <div className="settings-modal setup-wizard__modal--loading">
          <p className="setup-wizard__loading-text">checking environment...</p>
        </div>
      </div>
    )
  }

  if (!isTauri() || !diagnostic) {
    return null
  }

  const hasIssues = diagnostic.issues.length > 0
  const criticalIssues = diagnostic.issues.filter(i => i.severity === 'error')
  const warnings = diagnostic.issues.filter(i => i.severity === 'warning')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="settings-modal setup-wizard__modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="setup-wizard__header">
          <span className="setup-wizard__title">
            environment check
          </span>
          <button
            onClick={onClose}
            className="setup-wizard__close-btn"
          >
            [esc]
          </button>
        </div>

        <div className="setup-wizard__diagnostic-box">
          <div>session: {diagnostic.session_type} | compositor: {diagnostic.compositor}</div>
          <div>
            <StatusIcon ok={diagnostic.pipewire_ok} /> pipewire
            {'  '}
            <StatusIcon ok={diagnostic.pipewire_pulse_ok} /> pipewire-pulse
            {'  '}
            <StatusIcon ok={diagnostic.portal_ok} /> portal ({diagnostic.portal_backend})
          </div>
        </div>

        {!hasIssues && (
          <p className="setup-wizard__status-all-ok">
            environment looks good — you're all set
          </p>
        )}

        {criticalIssues.length > 0 && (
          <div className="setup-wizard__issues-section">
            <p className="setup-wizard__issues-header setup-wizard__issues-header--error">
              issues found ({criticalIssues.length})
            </p>
            {criticalIssues.map((issue, i) => (
              <IssueCard key={i} issue={issue} copiedCmd={copiedCmd} onCopy={handleCopy} />
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="setup-wizard__issues-section">
            <p className="setup-wizard__issues-header setup-wizard__issues-header--warning">
              warnings ({warnings.length})
            </p>
            {warnings.map((issue, i) => (
              <IssueCard key={i} issue={issue} copiedCmd={copiedCmd} onCopy={handleCopy} />
            ))}
          </div>
        )}

        <div className="setup-wizard__footer">
          {hasIssues && (
            <button
              onClick={handleDontShowAgain}
              className="setup-wizard__dismiss-btn"
            >
              don't show again
            </button>
          )}
          <button
            onClick={handleDismiss}
            className="setup-wizard__confirm-btn"
          >
            {hasIssues ? 'i understand' : 'got it'}
          </button>
        </div>
      </div>
    </div>
  )
}

function IssueCard({
  issue,
  copiedCmd,
  onCopy,
}: {
  issue: EnvIssue
  copiedCmd: string | null
  onCopy: (cmd: string) => void
}) {
  return (
    <div className="setup-wizard__issue">
      <div className="setup-wizard__issue-header">
        <span className="setup-wizard__issue-component">{issue.component}</span>
        <span className={`setup-wizard__issue-severity ${issue.severity === 'error' ? 'setup-wizard__issue-severity--error' : 'setup-wizard__issue-severity--warning'}`}>
          {issue.severity}
        </span>
      </div>
      <p className="setup-wizard__issue-message">
        {issue.message}
      </p>
      {issue.fix_command && (
        <div className="setup-wizard__issue-fix-row">
          <code className="setup-wizard__issue-fix-cmd">
            {issue.fix_command}
          </code>
          <button
            onClick={() => onCopy(issue.fix_command!)}
            className={`setup-wizard__issue-copy-btn ${copiedCmd === issue.fix_command ? 'setup-wizard__issue-copy-btn--copied' : ''}`}
          >
            {copiedCmd === issue.fix_command ? 'copied' : 'copy'}
          </button>
        </div>
      )}
    </div>
  )
}
