import { useChatStore } from '../store/chatStore'
import { useUpdaterActions } from '../hooks/useUpdater'
import '../styles/update-banner.css'

export default function UpdateBanner() {
  const updateState = useChatStore((s) => s.updateState)
  const updateProgress = useChatStore((s) => s.updateProgress)
  const updateVersion = useChatStore((s) => s.updateVersion)
  const updateError = useChatStore((s) => s.updateError)
  const { installUpdate } = useUpdaterActions()

  if (updateState === 'idle') return null

  if (updateState === 'error') {
    return (
      <div className="update-banner update-banner--error">
        update failed: {updateError ?? 'unknown error'}
      </div>
    )
  }

  if (updateState === 'checking') {
    return (
      <div className="update-banner update-banner--checking">
        checking for updates...
      </div>
    )
  }

  if (updateState === 'downloading') {
    return (
      <div className="update-banner update-banner--downloading">
        <div className="update-banner__row">
          <span>downloading update {updateVersion}</span>
          <span>{updateProgress}%</span>
        </div>
        <div className="update-banner__progress">
          <div className="update-banner__progress-fill" style={{ width: `${updateProgress}%` }} />
        </div>
      </div>
    )
  }

  if (updateState === 'ready') {
    return (
      <div className="update-banner update-banner--ready">
        <span>update {updateVersion} ready</span>
        <button onClick={installUpdate} className="update-banner__restart-btn">
          restart now
        </button>
      </div>
    )
  }

  return null
}
