import { useState } from 'react'
import { User, Server } from 'lucide-react'
import Modal from './ui/Modal'
import { useServerStore } from '../store/serverStore'
import { UserSettingsBody } from './UserSettingsModal'
import { ServerSettingsBody } from './ServerMenuModal'
import './SettingsModal.css'

export type SettingsScope = 'you' | 'server'

interface Props {
  onClose: () => void
  /** Scope to open on. Defaults to 'you'. Falls back to 'you' with no session. */
  initialScope?: SettingsScope
  onBackgroundChanged?: () => void
}

/**
 * Unified settings hub. One entry point / one shell for both the "You" (app)
 * settings and the per-server settings that used to live in two separate
 * modals. A scope switcher pinned above the nav rail toggles between them; each
 * scope keeps its own proven section list and sizing.
 */
export default function SettingsModal({ onClose, initialScope = 'you', onBackgroundChanged }: Props) {
  const hasSession = useServerStore((s) => !!s.activeSession)
  const [scope, setScope] = useState<SettingsScope>(
    initialScope === 'server' && hasSession ? 'server' : 'you',
  )

  const serverAvailable = hasSession
  const activeScope: SettingsScope = scope === 'server' && !serverAvailable ? 'you' : scope

  const switcher = (
    <div className="settings-scope" role="tablist" aria-label="Settings scope">
      <button
        type="button"
        role="tab"
        aria-selected={activeScope === 'you'}
        className={`settings-scope__btn${activeScope === 'you' ? ' settings-scope__btn--active' : ''}`}
        onClick={() => setScope('you')}
      >
        <User size={14} />
        <span>you</span>
      </button>
      {serverAvailable && (
        <button
          type="button"
          role="tab"
          aria-selected={activeScope === 'server'}
          className={`settings-scope__btn${activeScope === 'server' ? ' settings-scope__btn--active' : ''}`}
          onClick={() => setScope('server')}
        >
          <Server size={14} />
          <span>server</span>
        </button>
      )}
    </div>
  )

  return (
    <Modal
      open
      onClose={onClose}
      title="// settings"
      // One stable shell class for every scope — the modal never resizes when
      // you switch between "you" and "server"; only the inner body swaps.
      className="settings-modal"
      footer={(handleClose) => (
        <button onClick={handleClose} className="settings-modal__done-btn">done</button>
      )}
    >
      {activeScope === 'you' ? (
        <UserSettingsBody onClose={onClose} navHeader={switcher} />
      ) : (
        <ServerSettingsBody onClose={onClose} onBackgroundChanged={onBackgroundChanged} navHeader={switcher} />
      )}
    </Modal>
  )
}
