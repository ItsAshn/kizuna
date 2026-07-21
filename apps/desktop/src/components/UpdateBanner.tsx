import { useEffect, useState } from 'react'
import { X, ChevronDown } from 'lucide-react'
import { useSettingsStore } from '../store/settingsStore'
import { useUpdaterActions, isMobileTauri } from '../hooks/useUpdater'
import { parseReleaseNotes } from '../utils/releaseNotes'
import './UpdateBanner.css'

/**
 * The single update surface in chat. It shows either what just changed after an
 * update landed, or a prompt for the two states that need a decision: an update
 * exists, or one is staged and waiting on a restart. Checking, progress and
 * errors stay in settings — they aren't actionable here.
 */
export default function UpdateBanner() {
  const updateState = useSettingsStore((s) => s.updateState)
  const updateVersion = useSettingsStore((s) => s.updateVersion)
  const updateNotes = useSettingsStore((s) => s.updateNotes)
  const postUpdateNote = useSettingsStore((s) => s.postUpdateNote)
  const setPostUpdateNote = useSettingsStore((s) => s.setPostUpdateNote)
  const { downloadUpdate, installUpdate } = useUpdaterActions()

  // `undefined` means nothing has been dismissed yet.
  const [dismissedVersion, setDismissedVersion] = useState<string | null | undefined>(undefined)
  const [notesOpen, setNotesOpen] = useState(false)

  // A dismissal applies to the version it was made against; a newer release —
  // or that version becoming installable — earns the banner back.
  useEffect(() => {
    if (updateState === 'ready') setDismissedVersion(undefined)
  }, [updateState])

  const mobile = isMobileTauri()

  // What just changed takes precedence: it's the thing the user hasn't seen.
  if (postUpdateNote) {
    const { lines } = parseReleaseNotes(postUpdateNote.notes)
    return (
      <div className={bannerClass(mobile, true)} role="status">
        <div className="update-banner__body">
          <span className="update-banner__text">updated to v{postUpdateNote.version}</span>
          {lines.length > 0 && (
            <ul className="update-banner__notes">
              {lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="update-banner__actions">
          <button
            className="update-banner__dismiss"
            onClick={() => setPostUpdateNote(null)}
            aria-label="dismiss what's new"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    )
  }

  const actionable = updateState === 'available' || updateState === 'downloading' || updateState === 'ready'
  if (!actionable) return null
  if (dismissedVersion !== undefined && dismissedVersion === updateVersion) return null

  const version = updateVersion ? `v${updateVersion}` : 'a new version'
  const { lines } = parseReleaseNotes(updateNotes)
  const canExpand = updateState === 'available' && lines.length > 0

  return (
    <div className={bannerClass(mobile, notesOpen && canExpand)} role="status">
      <div className="update-banner__body">
        <span className="update-banner__text">
          {updateState === 'ready'
            ? `${version} is installed — restart to finish`
            : updateState === 'downloading'
              ? `downloading ${version}…`
              : `${version} is available`}
        </span>
        {canExpand && notesOpen && (
          <ul className="update-banner__notes">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="update-banner__actions">
        {canExpand && (
          <button
            className="update-banner__notes-toggle"
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
          >
            what&rsquo;s new
            <ChevronDown
              size={12}
              className={`update-banner__chevron${notesOpen ? ' update-banner__chevron--open' : ''}`}
            />
          </button>
        )}
        {updateState === 'available' && (
          <button className="update-banner__action" onClick={() => void downloadUpdate()}>
            {mobile ? 'view release' : 'update'}
          </button>
        )}
        {updateState === 'ready' && (
          <button className="update-banner__action" onClick={() => void installUpdate()}>
            restart
          </button>
        )}
        {updateState !== 'downloading' && (
          <button
            className="update-banner__dismiss"
            onClick={() => setDismissedVersion(updateVersion)}
            aria-label="dismiss update notice"
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

// On mobile the banner is a sibling of the full-viewport shell, so it docks over
// the top instead of taking part in the flow.
function bannerClass(mobile: boolean, expanded: boolean): string {
  return [
    'update-banner',
    mobile && 'update-banner--docked',
    expanded && 'update-banner--expanded',
  ]
    .filter(Boolean)
    .join(' ')
}
