import { useEffect, useState } from 'react'
import { fetchEnvironment, type EnvDiagnostic } from './user-settings/EnvironmentSection'

/**
 * Header badge for a *broken* environment only. A healthy environment needs no
 * chat-header real estate — the full diagnostic lives in settings › environment
 * and can be opened from there at any time.
 */
export default function EnvStatus({ onOpenWizard }: { onOpenWizard: () => void }) {
  const [diagnostic, setDiagnostic] = useState<EnvDiagnostic | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchEnvironment().then((env) => {
      if (!cancelled) setDiagnostic(env)
    })
    return () => { cancelled = true }
  }, [])

  if (!diagnostic) return null

  const errorCount = diagnostic.issues.filter(i => i.severity === 'error').length
  const warnCount = diagnostic.issues.filter(i => i.severity === 'warning').length
  if (errorCount + warnCount === 0) return null

  const label = diagnostic.os === 'linux' ? diagnostic.compositor : diagnostic.os

  return (
    <button
      onClick={onOpenWizard}
      title={`${errorCount} error(s), ${warnCount} warning(s) — click for details`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'var(--error-bg)',
        border: 'none',
        borderRadius: 6,
        padding: '3px 8px',
        cursor: 'pointer',
        fontSize: 10,
        fontFamily: 'monospace',
        color: 'var(--error-faded)',
      }}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--error)',
        flexShrink: 0,
      }} />
      {label} ({errorCount + warnCount})
    </button>
  )
}
