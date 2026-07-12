import { useEffect, useState } from 'react'
import type { MonitorInfo } from '@kizuna/shared'
import { Monitor } from 'lucide-react'
import PickerSurface from './ui/PickerSurface'
import './ScreenShareOverlay.css'

interface MonitorPickerProps {
  onSelect: (monitorIndex: number) => void
  onCancel: () => void
}

export default function MonitorPicker({ onSelect, onCancel }: MonitorPickerProps) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const w = window as { __TAURI_INTERNALS__?: unknown }
    if (!w.__TAURI_INTERNALS__) {
      setError('Screensharing requires the desktop app. Run `pnpm tauri dev`.')
      setLoading(false)
      return
    }

    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<MonitorInfo[]>('list_monitors'))
      .then((list) => {
        setMonitors(list)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(`Failed to enumerate monitors: ${err}`)
        setLoading(false)
      })
  }, [])

  return (
    <PickerSurface base="monitor-picker" isMobile={false} onClose={onCancel}>
      <h2 className="monitor-picker__title">Select a screen to share</h2>

      {loading && <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Detecting monitors...</p>}

      {error && (
        <div>
          <p style={{ color: 'var(--red)', fontSize: '13px', marginBottom: 12 }}>{error}</p>
          <button className="monitor-picker__cancel" onClick={onCancel}>Cancel</button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="monitor-picker__list">
            {monitors.map((m) => (
              <button
                key={m.index}
                className="monitor-picker__item"
                onClick={() => onSelect(m.index)}
              >
                <Monitor className="monitor-picker__item-icon" />
                <div className="monitor-picker__item-info">
                  <span className="monitor-picker__item-name">{m.name}</span>
                  <span className="monitor-picker__item-res">
                    {m.width} x {m.height}
                  </span>
                </div>
              </button>
            ))}
            {monitors.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No monitors detected</p>
            )}
          </div>
          <button className="monitor-picker__cancel" onClick={onCancel}>Cancel</button>
        </>
      )}
    </PickerSurface>
  )
}
