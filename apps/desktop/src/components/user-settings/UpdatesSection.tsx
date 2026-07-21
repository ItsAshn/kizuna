import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settingsStore'
import { useUpdaterActions, isMobileTauri, RELEASES_URL } from '../../hooks/useUpdater'
import { parseReleaseNotes } from '../../utils/releaseNotes'

/**
 * The full update surface: current version, one action button whose label always
 * names the next step, and progress/errors — the detail the chat banner omits.
 */
export function UpdatesSection() {
  const updateState = useSettingsStore((s) => s.updateState)
  const updateProgress = useSettingsStore((s) => s.updateProgress)
  const updateVersion = useSettingsStore((s) => s.updateVersion)
  const updateError = useSettingsStore((s) => s.updateError)
  const updateNotes = useSettingsStore((s) => s.updateNotes)
  const { checkForUpdates, downloadUpdate, installUpdate, getVersion } = useUpdaterActions()

  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getVersion().then((v) => {
      if (!cancelled) setAppVersion(v)
    })
    return () => {
      cancelled = true
    }
  }, [getVersion])

  const mobile = isMobileTauri()
  const busy = updateState === 'checking' || updateState === 'downloading'
  const openReleasePage = () => window.open(RELEASES_URL, '_blank')

  // Notes are worth showing from the moment an update is found right through to
  // the restart prompt — they're the reason to take it.
  const showNotes = updateState === 'available' || updateState === 'downloading' || updateState === 'ready'
  const notes = showNotes ? parseReleaseNotes(updateNotes) : { lines: [], truncated: false }

  // One button, one next step — the label is never a progress readout.
  const action = (() => {
    switch (updateState) {
      case 'checking':
        return { label: 'checking…', onClick: () => {} }
      case 'available':
        return { label: mobile ? 'view release' : 'download update', onClick: downloadUpdate }
      case 'downloading':
        return { label: 'downloading…', onClick: () => {} }
      case 'ready':
        return { label: 'restart now', onClick: installUpdate }
      default:
        return { label: 'check for updates', onClick: () => checkForUpdates() }
    }
  })()

  const status = (() => {
    switch (updateState) {
      case 'upToDate':
        return { tone: 'muted', text: "you're on the latest version" }
      case 'available':
        return { tone: 'muted', text: `v${updateVersion} is available` }
      case 'ready':
        return { tone: 'success', text: `v${updateVersion} installed — restart to finish` }
      case 'error':
        return { tone: 'error', text: updateError || 'update check failed' }
      default:
        return null
    }
  })()

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <p className="settings-card-title">version</p>

        <div className="settings-version-row">
          <span className="settings-version-text">
            Kizuna {appVersion ? `v${appVersion}` : <span className="settings-version-dev">(dev build)</span>}
          </span>
          <button onClick={action.onClick} disabled={busy} className="settings-btn">
            {action.label}
          </button>
        </div>

        {updateState === 'downloading' && (
          <div className="settings-update-progress">
            <div className="settings-update-progress__bar">
              <div
                className="settings-update-progress__fill"
                style={{ width: `${updateProgress}%` }}
              />
            </div>
            <span className="settings-update-progress__value">{updateProgress}%</span>
          </div>
        )}

        {status && (
          <p
            className={
              status.tone === 'muted'
                ? 'settings-hint'
                : `settings-alert settings-alert--${status.tone}`
            }
          >
            {status.text}
          </p>
        )}

        {notes.lines.length > 0 && (
          <div className="settings-release-notes">
            <p className="settings-release-notes__title">
              {updateState === 'ready' ? 'included in this update' : "what's new"}
            </p>
            <ul className="settings-release-notes__list">
              {notes.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            {notes.truncated && (
              <button className="settings-release-notes__more" onClick={openReleasePage}>
                view full release notes
              </button>
            )}
          </div>
        )}

        {mobile && (
          <p className="settings-hint">
            updates install from the release page — kizuna can't replace itself on mobile
          </p>
        )}
      </div>
    </div>
  )
}
