import { useEffect, useState, type MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { Loader2 } from 'lucide-react'
import { useSettingsStore } from '../store/settingsStore'
import './ConnectionBanner.css'

/**
 * Every app launch (and every wake from sleep) drops the socket for a moment
 * before it comes back on its own, so announcing the gap immediately means the
 * banner fires on a problem that has already fixed itself. Wait out the grace
 * period first: if the socket is back before it elapses, the user never learns
 * there was a gap.
 */
const GRACE_MS = 3000

/**
 * Attempt counts are only worth surfacing once retrying has visibly failed a
 * few times — before that they read as noise on a connection that is fine.
 */
const ATTEMPTS_VISIBLE_FROM = 3

interface ConnectionBannerProps {
  socketRef: MutableRefObject<Socket | null>
}

export default function ConnectionBanner({ socketRef }: ConnectionBannerProps) {
  const socketConnected = useSettingsStore((s) => s.socketConnected)
  const socketReconnecting = useSettingsStore((s) => s.socketReconnecting)
  const socketReconnectAttempts = useSettingsStore((s) => s.socketReconnectAttempts)
  const [visible, setVisible] = useState(false)

  // Only `socketConnected` gates the timer — attempt counts tick during a
  // retry and must not restart the grace period.
  useEffect(() => {
    if (socketConnected) {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), GRACE_MS)
    return () => clearTimeout(timer)
  }, [socketConnected])

  if (!visible) return null

  return (
    <div
      className={`connection-banner${socketReconnecting ? ' connection-banner--reconnecting' : ''}`}
      role="status"
      aria-live="polite"
    >
      {socketReconnecting ? (
        <>
          <Loader2 size={12} className="connection-banner__spinner" />
          reconnecting
          {socketReconnectAttempts >= ATTEMPTS_VISIBLE_FROM
            ? ` · attempt ${socketReconnectAttempts}`
            : ''}
        </>
      ) : (
        <>
          <span className="connection-banner__dot" />
          disconnected
          <button
            className="connection-banner__reconnect"
            onClick={() => socketRef.current?.connect()}
          >
            retry
          </button>
        </>
      )}
    </div>
  )
}
