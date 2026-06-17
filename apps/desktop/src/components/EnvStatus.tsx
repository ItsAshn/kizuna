import { useEffect, useState, useCallback } from 'react'

interface EnvDiagnostic {
  session_type: string
  compositor: string
  pipewire_ok: boolean
  pipewire_pulse_ok: boolean
  portal_ok: boolean
  portal_backend: string
  issues: Array<{ severity: string; component: string; message: string }>
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

export default function EnvStatus({ onOpenWizard }: { onOpenWizard: () => void }) {
  const [diagnostic, setDiagnostic] = useState<EnvDiagnostic | null>(null)

  const refresh = useCallback(() => {
    if (!isTauri()) return
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<EnvDiagnostic>('get_environment'))
      .then(setDiagnostic)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!diagnostic) return null

  const errorCount = diagnostic.issues.filter(i => i.severity === 'error').length
  const warnCount = diagnostic.issues.filter(i => i.severity === 'warning').length
  const hasIssues = errorCount > 0 || warnCount > 0

  return (
    <button
      onClick={onOpenWizard}
      title={
        hasIssues
          ? `${errorCount} error(s), ${warnCount} warning(s) — click for details`
          : `${diagnostic.compositor} (${diagnostic.session_type}) — environment OK`
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: hasIssues ? 'var(--error-bg)' : 'var(--success-bg)',
        border: 'none',
        borderRadius: 6,
        padding: '3px 8px',
        cursor: 'pointer',
        fontSize: 10,
        fontFamily: 'monospace',
        color: hasIssues ? 'var(--error-faded)' : 'var(--success-faded)',
      }}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: hasIssues ? 'var(--error)' : 'var(--success)',
        flexShrink: 0,
      }} />
      {diagnostic.compositor}
      {hasIssues && ` (${errorCount + warnCount})`}
    </button>
  )
}
