import { useCallback, useEffect, useState } from 'react'
import { isTauri } from '../../utils/platform'
import './EnvironmentSection.css'

interface EnvIssue {
  severity: string
  component: string
  message: string
  fix_command: string | null
}

export interface EnvDiagnostic {
  os: string
  session_type: string
  compositor: string
  pipewire_ok: boolean
  pipewire_pulse_ok: boolean
  portal_ok: boolean
  portal_backend: string
  issues: EnvIssue[]
}

/** Shared fetch for the diagnostic — used by the panel and by EnvStatus. */
export function fetchEnvironment(): Promise<EnvDiagnostic | null> {
  if (!isTauri()) return Promise.resolve(null)
  return import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<EnvDiagnostic>('get_environment'))
    .catch(() => null)
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="env-check-row">
      <span className={`env-check-pill ${ok ? 'env-check-pill--ok' : 'env-check-pill--fail'}`}>
        {ok ? 'ok' : 'fail'}
      </span>
      <span className="env-check-label">{label}</span>
      {detail && <span className="env-check-detail">{detail}</span>}
    </div>
  )
}

export function EnvironmentSection() {
  const [diagnostic, setDiagnostic] = useState<EnvDiagnostic | null>(null)
  const [loading, setLoading] = useState(true)
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    fetchEnvironment()
      .then(setDiagnostic)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCopy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopiedCmd(cmd)
      setTimeout(() => setCopiedCmd(null), 2000)
    } catch {
      /* clipboard unavailable */
    }
  }

  if (loading && !diagnostic) {
    return (
      <div className="settings-tab-content">
        <div className="settings-card">
          <p className="settings-hint">checking environment...</p>
        </div>
      </div>
    )
  }

  if (!diagnostic) {
    return (
      <div className="settings-tab-content">
        <div className="settings-card">
          <p className="settings-card-title">environment</p>
          <p className="settings-hint">diagnostics are only available in the desktop app</p>
        </div>
      </div>
    )
  }

  const isLinux = diagnostic.os === 'linux'
  const errors = diagnostic.issues.filter(i => i.severity === 'error')
  const warnings = diagnostic.issues.filter(i => i.severity === 'warning')

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <div className="env-card-header">
          <p className="settings-card-title">system</p>
          <button onClick={refresh} disabled={loading} className="settings-btn">
            {loading ? 'checking...' : 're-check'}
          </button>
        </div>

        {isLinux ? (
          <>
            <div className="env-meta">
              <span>session: {diagnostic.session_type || 'unknown'}</span>
              <span>compositor: {diagnostic.compositor || 'unknown'}</span>
            </div>
            <CheckRow label="pipewire" ok={diagnostic.pipewire_ok} />
            <CheckRow label="pipewire-pulse" ok={diagnostic.pipewire_pulse_ok} />
            <CheckRow label="portal" ok={diagnostic.portal_ok} detail={diagnostic.portal_backend} />
          </>
        ) : (
          <div className="env-meta">
            <span>platform: {diagnostic.os || 'unknown'}</span>
          </div>
        )}

        {diagnostic.issues.length === 0 && (
          <p className="settings-alert settings-alert--success">
            {isLinux
              ? "environment looks good — you're all set"
              : 'screen capture and audio use native APIs on this platform — no setup required'}
          </p>
        )}
      </div>

      {errors.length > 0 && (
        <div className="settings-card">
          <p className="settings-card-title">issues ({errors.length})</p>
          {errors.map((issue, i) => (
            <IssueCard key={i} issue={issue} copiedCmd={copiedCmd} onCopy={handleCopy} />
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="settings-card">
          <p className="settings-card-title">warnings ({warnings.length})</p>
          {warnings.map((issue, i) => (
            <IssueCard key={i} issue={issue} copiedCmd={copiedCmd} onCopy={handleCopy} />
          ))}
        </div>
      )}
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
    <div className="env-issue">
      <div className="env-issue-header">
        <span className="env-issue-component">{issue.component}</span>
        <span className={`env-issue-severity env-issue-severity--${issue.severity === 'error' ? 'error' : 'warning'}`}>
          {issue.severity}
        </span>
      </div>
      <p className="env-issue-message">{issue.message}</p>
      {issue.fix_command && (
        <div className="env-issue-fix">
          <code className="env-issue-cmd">{issue.fix_command}</code>
          <button
            onClick={() => onCopy(issue.fix_command!)}
            className="settings-btn"
          >
            {copiedCmd === issue.fix_command ? 'copied' : 'copy'}
          </button>
        </div>
      )}
    </div>
  )
}
