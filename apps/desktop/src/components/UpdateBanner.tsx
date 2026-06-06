import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { useUpdaterActions } from '../hooks/useUpdater'
import '../styles/update-banner.css'

export default function UpdateBanner() {
  const updateState = useChatStore((s) => s.updateState)
  const updateProgress = useChatStore((s) => s.updateProgress)
  const updateVersion = useChatStore((s) => s.updateVersion)
  const updateError = useChatStore((s) => s.updateError)
  const { installUpdate } = useUpdaterActions()
  const [dismissed, setDismissed] = useState(false)
  const prevStateRef = useRef(updateState)

  useEffect(() => {
    if (prevStateRef.current !== updateState) {
      prevStateRef.current = updateState
      setDismissed(false)
    }
  }, [updateState])

  useEffect(() => {
    if (updateState === 'idle') {
      setDismissed(false)
    }
  }, [updateState])

  if (updateState === 'idle' || dismissed) return null

  return (
    <div className="update-banner-card">
      <button className="update-banner-card__close-btn" onClick={() => setDismissed(true)}>
        [esc]
      </button>

      {updateState === 'error' && (
        <div className="update-banner-card__content update-banner-card__content--error">
          update failed: {updateError ?? 'unknown error'}
        </div>
      )}

      {updateState === 'checking' && (
        <div className="update-banner-card__content update-banner-card__content--checking">
          checking for updates...
        </div>
      )}

      {updateState === 'downloading' && (
        <div className="update-banner-card__content update-banner-card__content--downloading">
          <div className="update-banner-card__row">
            <span>downloading update {updateVersion}</span>
            <span>{updateProgress}%</span>
          </div>
          <div className="update-banner-card__progress">
            <div
              className="update-banner-card__progress-fill"
              style={{ width: `${updateProgress}%` }}
            />
          </div>
        </div>
      )}

      {updateState === 'ready' && (
        <div className="update-banner-card__content update-banner-card__content--ready">
          <span>update {updateVersion} ready</span>
          <button onClick={installUpdate} className="update-banner-card__restart-btn">
            restart now
          </button>
        </div>
      )}
    </div>
  )
}
