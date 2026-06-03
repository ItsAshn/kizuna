import { useEffect, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import '../styles/settings.css'

interface Props {
  onClose: () => void
}

const BITRATE_OPTIONS = [
  { value: 32, label: '32 kbps — low bandwidth' },
  { value: 64, label: '64 kbps — balanced' },
  { value: 96, label: '96 kbps' },
  { value: 128, label: '128 kbps — high quality' },
  { value: 192, label: '192 kbps' },
  { value: 256, label: '256 kbps' },
  { value: 320, label: '320 kbps — max quality' },
]

export default function SettingsModal({ onClose }: Props) {
  const {
    audioInputDeviceId, setAudioInputDeviceId,
    audioOutputDeviceId, setAudioOutputDeviceId,
    audioBitrateKbps, setAudioBitrateKbps,
  } = useChatStore()

  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([])
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [appVersion, setAppVersion] = useState('0.1.0')

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  useEffect(() => {
    async function loadDevices() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(t => t.stop())
      } catch {
        setPermissionDenied(true)
        return
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      setInputDevices(devices.filter(d => d.kind === 'audioinput'))
      setOutputDevices(devices.filter(d => d.kind === 'audiooutput'))
    }
    loadDevices()
  }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal__header">
          <span className="settings-modal__header-title">// settings</span>
          <button onClick={onClose} className="settings-modal__close-btn">[esc]</button>
        </div>

        <div className="settings-modal__body">
          {permissionDenied && (
            <p className="settings-modal__permission-warning">
              microphone permission denied — device labels unavailable
            </p>
          )}

          <section>
            <p className="settings-modal__section-title">audio input (microphone)</p>
            <select
              value={audioInputDeviceId ?? ''}
              onChange={(e) => setAudioInputDeviceId(e.target.value || null)}
              className="settings-modal__select"
            >
              <option value="">system default</option>
              {inputDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `microphone (${d.deviceId.slice(0, 8)}...)`}
                </option>
              ))}
            </select>
          </section>

          <section>
            <p className="settings-modal__section-title">audio output (speakers / headphones)</p>
            {outputDevices.length === 0 ? (
              <p className="settings-modal__alert">
                output device selection not supported in this environment
              </p>
            ) : (
              <select
                value={audioOutputDeviceId ?? ''}
                onChange={(e) => setAudioOutputDeviceId(e.target.value || null)}
                className="settings-modal__select"
              >
                <option value="">system default</option>
                {outputDevices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `speaker (${d.deviceId.slice(0, 8)}...)`}
                  </option>
                ))}
              </select>
            )}
          </section>

          <section>
            <p className="settings-modal__section-title">voice bitrate</p>
            <select
              value={audioBitrateKbps}
              onChange={(e) => setAudioBitrateKbps(Number(e.target.value))}
              className="settings-modal__select"
            >
              {BITRATE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="settings-modal__hint">takes effect on next voice channel join</p>
          </section>

          <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
            <p className="settings-modal__section-title">app version</p>
            <div className="settings-modal__version-row">
              <span className="settings-modal__version-text">Kizuna v{appVersion}</span>
              <span className="settings-modal__version-tag">self-hosted</span>
            </div>
          </section>
        </div>

        <div className="settings-modal__footer">
          <button onClick={onClose} className="settings-modal__done-btn">done</button>
        </div>
      </div>
    </div>
  )
}
