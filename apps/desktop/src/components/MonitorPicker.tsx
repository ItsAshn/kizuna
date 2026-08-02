import { useEffect, useState } from 'react'
import type { MonitorInfo } from '@kizuna/shared'
import { Monitor } from 'lucide-react'
import PickerSurface from './ui/PickerSurface'
import { useVoiceStore } from '../store/voiceStore'
import './ScreenShareOverlay.css'

interface MonitorPickerProps {
  onSelect: (monitorIndex: number, fps: number) => void
  onCancel: () => void
}

/**
 * Frame rate is a real trade-off between motion and bandwidth, so it belongs in
 * the picker rather than hardcoded. 15fps used to be the only option, which made
 * anything but a slide deck look broken.
 */
const FPS_OPTIONS: { value: number; label: string; desc: string }[] = [
  { value: 15, label: '15 fps', desc: 'slides, docs — lowest bandwidth' },
  { value: 30, label: '30 fps', desc: 'general use' },
  { value: 60, label: '60 fps', desc: 'video, games — highest bandwidth' },
]

export default function MonitorPicker({ onSelect, onCancel }: MonitorPickerProps) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const screenShareFps = useVoiceStore((s) => s.screenShareFps)
  const setScreenShareFps = useVoiceStore((s) => s.setScreenShareFps)

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

      {loading && (
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Detecting monitors...</p>
      )}

      {error && (
        <div>
          <p style={{ color: 'var(--red)', fontSize: '13px', marginBottom: 12 }}>{error}</p>
          <button className="monitor-picker__cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="monitor-picker__list">
            {monitors.map((m) => (
              <button
                key={m.index}
                className="monitor-picker__item"
                onClick={() => onSelect(m.index, screenShareFps)}
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

          <div className="monitor-picker__fps" role="radiogroup" aria-label="Frame rate">
            <span className="monitor-picker__fps-label">Frame rate</span>
            <div className="monitor-picker__fps-options">
              {FPS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={screenShareFps === opt.value}
                  title={opt.desc}
                  onClick={() => setScreenShareFps(opt.value)}
                  className={`monitor-picker__fps-btn${
                    screenShareFps === opt.value ? ' monitor-picker__fps-btn--active' : ''
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <span className="monitor-picker__fps-desc">
              {FPS_OPTIONS.find((o) => o.value === screenShareFps)?.desc}
            </span>
          </div>

          <button className="monitor-picker__cancel" onClick={onCancel}>
            Cancel
          </button>
        </>
      )}
    </PickerSurface>
  )
}
