import { useEffect, useState } from 'react'

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
  return <span style={{ color: ok ? '#4ade80' : '#f87171', fontWeight: 700 }}>{ok ? 'OK' : '!'}</span>
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
        <div className="settings-modal" style={{ maxWidth: 480, padding: '24px' }}>
          <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>checking environment...</p>
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
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520, maxHeight: '80vh', overflow: 'auto' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 13 }}>
            environment check
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}
          >
            [esc]
          </button>
        </div>

        <div style={{
          background: 'var(--bg-secondary)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: 1.6,
          color: 'var(--text-secondary)',
        }}>
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
          <p style={{ color: '#4ade80', fontSize: 12, textAlign: 'center', marginBottom: 16 }}>
            environment looks good — you're all set
          </p>
        )}

        {criticalIssues.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ color: '#f87171', fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
              issues found ({criticalIssues.length})
            </p>
            {criticalIssues.map((issue, i) => (
              <IssueCard key={i} issue={issue} copiedCmd={copiedCmd} onCopy={handleCopy} />
            ))}
          </div>
        )}

        {warnings.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ color: '#fbbf24', fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
              warnings ({warnings.length})
            </p>
            {warnings.map((issue, i) => (
              <IssueCard key={i} issue={issue} copiedCmd={copiedCmd} onCopy={handleCopy} />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          {hasIssues && (
            <button
              onClick={handleDontShowAgain}
              style={{
                background: 'none',
                border: '1px solid var(--border-color)',
                color: 'var(--text-muted)',
                padding: '6px 14px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              don't show again
            </button>
          )}
          <button
            onClick={handleDismiss}
            style={{
              background: 'var(--accent-color)',
              border: 'none',
              color: '#fff',
              padding: '6px 18px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
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
    <div
      style={{
        background: 'var(--bg-primary)',
        borderRadius: 6,
        padding: 10,
        marginBottom: 8,
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{issue.component}</span>
        <span style={{
          color: issue.severity === 'error' ? '#f87171' : '#fbbf24',
          fontSize: 9,
          textTransform: 'uppercase',
          fontWeight: 600,
        }}>
          {issue.severity}
        </span>
      </div>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 6px 0' }}>
        {issue.message}
      </p>
      {issue.fix_command && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <code
            style={{
              display: 'block',
              background: 'var(--bg-tertiary, #1a1a2e)',
              padding: '6px 8px',
              borderRadius: 4,
              fontSize: 10,
              color: 'var(--text-muted)',
              flex: 1,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {issue.fix_command}
          </code>
          <button
            onClick={() => onCopy(issue.fix_command!)}
            style={{
              background: copiedCmd === issue.fix_command ? '#4ade80' : 'var(--border-color)',
              border: 'none',
              color: copiedCmd === issue.fix_command ? '#000' : 'var(--text-secondary)',
              padding: '4px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 10,
              whiteSpace: 'nowrap',
            }}
          >
            {copiedCmd === issue.fix_command ? 'copied' : 'copy'}
          </button>
        </div>
      )}
    </div>
  )
}
