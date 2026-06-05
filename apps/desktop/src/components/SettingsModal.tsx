import { useEffect, useState, useCallback, useRef } from 'react'
import { useChatStore, type VoiceInputMode } from '../store/chatStore'
import { useUpdaterActions } from '../hooks/useUpdater'
import '../styles/settings.css'

interface Props {
  onClose: () => void
}

interface AudioDevice {
  name: string
  device_id: string
  is_default: boolean
  max_channels: number
  default_sample_rate: number
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

const INPUT_MODES: { value: VoiceInputMode; label: string; desc: string }[] = [
  { value: 'voice-activity', label: 'voice activity', desc: 'automatically transmit when you speak' },
  { value: 'push-to-talk', label: 'push to talk', desc: 'hold a key to transmit' },
]

function thresholdToRms(value: number): number {
  return Math.max(1, Math.round(50 * Math.exp(-value * 0.04)))
}

function rmsToLevel(rms: number): number {
  return Math.min(100, Math.round((rms / 40) * 100))
}

function keyCodeToLabel(code: string): string {
  const map: Record<string, string> = {
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    Space: 'Space',
    Backquote: '`',
    CapsLock: 'Caps Lock',
    Tab: 'Tab',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Minus: '-',
    Equal: '=',
  }
  if (map[code]) return map[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Numpad ' + code.slice(6)
  return code
}

export default function SettingsModal({ onClose }: Props) {
  const {
    audioInputDeviceId, setAudioInputDeviceId,
    audioOutputDeviceId, setAudioOutputDeviceId,
    voiceInputMode, setVoiceInputMode,
    voiceGateThreshold, setVoiceGateThreshold,
    pushToTalkKey, setPushToTalkKey,
    noiseSuppression, setNoiseSuppression,
    echoCancellation, setEchoCancellation,
    autoGainControl, setAutoGainControl,
    inputVolume, setInputVolume,
    outputVolume, setOutputVolume,
    liveAudioLevel,
    updateState, updateProgress, updateVersion, updateError,
  } = useChatStore()
  const { checkForUpdates, getVersion } = useUpdaterActions()

  const [inputDevices, setInputDevices] = useState<AudioDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<AudioDevice[] | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [appVersion, setAppVersion] = useState('0.1.0')
  const [isDev, setIsDev] = useState(true)
  const [listeningForKey, setListeningForKey] = useState(false)
  const unmountedRef = useRef(false)

  const rmsThreshold = thresholdToRms(voiceGateThreshold)
  const meterLevel = rmsToLevel(liveAudioLevel)
  const thresholdLevel = rmsToLevel(rmsThreshold)

  const handleKeyCapture = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPushToTalkKey(e.code)
    setListeningForKey(false)
  }, [setPushToTalkKey])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (listeningForKey) {
        handleKeyCapture(e)
        return
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [onClose, listeningForKey, handleKeyCapture])

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true)
    setPermissionDenied(false)

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const [inputs, outputs] = await Promise.all([
          invoke<AudioDevice[]>('list_audio_input_devices'),
          invoke<AudioDevice[]>('list_audio_output_devices'),
        ])
        if (!unmountedRef.current) {
          setInputDevices(inputs)
          setOutputDevices(outputs)
        }
      } catch (err) {
        console.error('Failed to list audio devices via Tauri:', err)
        if (!unmountedRef.current) {
          setInputDevices([])
          setOutputDevices([])
        }
      }
    } else {
      try {
        const devices = await Promise.race([
          navigator.mediaDevices.enumerateDevices(),
          new Promise<MediaDeviceInfo[]>((_, reject) =>
            setTimeout(() => reject(new Error('Device enumeration timed out')), 3000)
          ),
        ])
        if (unmountedRef.current) return
        setInputDevices(
          devices
            .filter(d => d.kind === 'audioinput')
            .map(d => ({
              name: d.label || `microphone (${d.deviceId.slice(0, 8)}...)`,
              device_id: d.deviceId,
              is_default: d.deviceId === 'default',
              max_channels: 1,
              default_sample_rate: 48000,
            }))
        )
        setOutputDevices(
          devices
            .filter(d => d.kind === 'audiooutput')
            .map(d => ({
              name: d.label || `speaker (${d.deviceId.slice(0, 8)}...)`,
              device_id: d.deviceId,
              is_default: d.deviceId === 'default',
              max_channels: 2,
              default_sample_rate: 48000,
            }))
        )
      } catch {
        if (!unmountedRef.current) {
          setInputDevices([])
          setOutputDevices([])
        }
      }

      try {
        const stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ audio: true }),
          new Promise<MediaStream>((_, reject) =>
            setTimeout(() => reject(new Error('Permission request timed out')), 3000)
          ),
        ])
        if (unmountedRef.current) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        stream.getTracks().forEach(t => t.stop())

        const devices = await Promise.race([
          navigator.mediaDevices.enumerateDevices(),
          new Promise<MediaDeviceInfo[]>((_, reject) =>
            setTimeout(() => reject(new Error('Device enumeration timed out')), 3000)
          ),
        ])
        if (unmountedRef.current) return
        setInputDevices(
          devices
            .filter(d => d.kind === 'audioinput')
            .map(d => ({
              name: d.label || `microphone (${d.deviceId.slice(0, 8)}...)`,
              device_id: d.deviceId,
              is_default: d.deviceId === 'default',
              max_channels: 1,
              default_sample_rate: 48000,
            }))
        )
        setOutputDevices(
          devices
            .filter(d => d.kind === 'audiooutput')
            .map(d => ({
              name: d.label || `speaker (${d.deviceId.slice(0, 8)}...)`,
              device_id: d.deviceId,
              is_default: d.deviceId === 'default',
              max_channels: 2,
              default_sample_rate: 48000,
            }))
        )
      } catch {
        if (!unmountedRef.current) setPermissionDenied(true)
      }
    }

    if (!unmountedRef.current) setDevicesLoading(false)
  }, [])

  useEffect(() => {
    unmountedRef.current = false
    getVersion().then(v => {
      if (!unmountedRef.current) {
        setAppVersion(v)
        setIsDev(false)
      }
    })
    loadDevices()
    return () => { unmountedRef.current = true }
  }, [loadDevices])

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
            <p className="settings-modal__section-title">audio devices</p>
            {inputDevices === null ? (
              <button
                onClick={loadDevices}
                disabled={devicesLoading}
                className="settings-modal__check-btn"
              >
                {devicesLoading ? 'detecting...' : 'detect audio devices'}
              </button>
            ) : (
              <>
                <p className="settings-modal__hint" style={{ marginBottom: '6px' }}>input (microphone)</p>
                <select
                  value={audioInputDeviceId ?? ''}
                  onChange={(e) => setAudioInputDeviceId(e.target.value || null)}
                  className="settings-modal__select"
                >
                  <option value="">system default</option>
                  {inputDevices.map(d => (
                    <option key={d.device_id} value={d.device_id}>
                      {d.name}{d.is_default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <p className="settings-modal__hint" style={{ marginTop: '10px', marginBottom: '6px' }}>output (speakers / headphones)</p>
                {outputDevices && outputDevices.length > 0 ? (
                  <select
                    value={audioOutputDeviceId ?? ''}
                    onChange={(e) => setAudioOutputDeviceId(e.target.value || null)}
                    className="settings-modal__select"
                  >
                    <option value="">system default</option>
                    {outputDevices.map(d => (
                      <option key={d.device_id} value={d.device_id}>
                        {d.name}{d.is_default ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="settings-modal__alert">
                    output device selection not supported in this environment
                  </p>
                )}
              </>
            )}
          </section>

          <hr className="settings-modal__section-divider" />

          <section>
            <p className="settings-modal__section-title">input mode</p>
            <div className="settings-modal__radio-group">
              {INPUT_MODES.map(mode => (
                <div
                  key={mode.value}
                  className={`settings-modal__radio-option${voiceInputMode === mode.value ? ' settings-modal__radio-option--active' : ''}`}
                  onClick={() => setVoiceInputMode(mode.value)}
                >
                  <span className="settings-modal__radio-dot" />
                  <div>
                    <div style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{mode.label}</div>
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{mode.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {voiceInputMode === 'push-to-talk' && (
            <section>
              <p className="settings-modal__section-title">push to talk keybind</p>
              <div className="settings-modal__keybind-row">
                <span className="settings-modal__keybind-label">shortcut</span>
                <button
                  className={`settings-modal__keybind-btn${listeningForKey ? ' settings-modal__keybind-btn--listening' : ''}`}
                  onClick={() => setListeningForKey(true)}
                  onBlur={() => setListeningForKey(false)}
                >
                  {listeningForKey ? 'press a key...' : keyCodeToLabel(pushToTalkKey)}
                </button>
              </div>
            </section>
          )}

          {voiceInputMode === 'voice-activity' && (
            <section>
              <p className="settings-modal__section-title">voice activity sensitivity</p>
              <div className="settings-modal__slider-section">
                <div className="settings-modal__meter-bar">
                  <div
                    className={`settings-modal__meter-fill${meterLevel < thresholdLevel ? ' settings-modal__meter-fill--low' : meterLevel < thresholdLevel * 1.5 ? ' settings-modal__meter-fill--mid' : ' settings-modal__meter-fill--high'}`}
                    style={{ width: `${meterLevel}%` }}
                  />
                  <div
                    className="settings-modal__meter-threshold"
                    style={{ left: `${thresholdLevel}%` }}
                  />
                </div>
                <div className="settings-modal__slider-row">
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={voiceGateThreshold}
                    onChange={(e) => setVoiceGateThreshold(Number(e.target.value))}
                    className="settings-modal__slider"
                    style={{ '--slider-pct': `${voiceGateThreshold}%` } as React.CSSProperties}
                  />
                  <span className="settings-modal__slider-value">{voiceGateThreshold}%</span>
                </div>
                <p className="settings-modal__hint">
                  higher = more sensitive. green bar = your current audio level
                </p>
              </div>
            </section>
          )}

          <hr className="settings-modal__section-divider" />

          <section>
            <p className="settings-modal__section-title">audio processing</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div className="settings-modal__toggle-row">
                <span className="settings-modal__toggle-label">noise suppression</span>
                <label className="settings-modal__toggle">
                  <input
                    type="checkbox"
                    checked={noiseSuppression}
                    onChange={(e) => setNoiseSuppression(e.target.checked)}
                  />
                  <span className="settings-modal__toggle-track">
                    <span className="settings-modal__toggle-thumb" />
                  </span>
                </label>
              </div>
              <div className="settings-modal__toggle-row">
                <span className="settings-modal__toggle-label">echo cancellation</span>
                <label className="settings-modal__toggle">
                  <input
                    type="checkbox"
                    checked={echoCancellation}
                    onChange={(e) => setEchoCancellation(e.target.checked)}
                  />
                  <span className="settings-modal__toggle-track">
                    <span className="settings-modal__toggle-thumb" />
                  </span>
                </label>
              </div>
              <div className="settings-modal__toggle-row">
                <span className="settings-modal__toggle-label">auto gain control</span>
                <label className="settings-modal__toggle">
                  <input
                    type="checkbox"
                    checked={autoGainControl}
                    onChange={(e) => setAutoGainControl(e.target.checked)}
                  />
                  <span className="settings-modal__toggle-track">
                    <span className="settings-modal__toggle-thumb" />
                  </span>
                </label>
              </div>
            </div>
            <p className="settings-modal__hint" style={{ marginTop: '8px' }}>
              {isTauri()
                ? 'browser-based processing is not available with native audio capture'
                : 'applied on next voice channel join'}
            </p>
          </section>

          <hr className="settings-modal__section-divider" />

          <section>
            <p className="settings-modal__section-title">volume</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <p className="settings-modal__hint" style={{ marginBottom: '4px' }}>input volume</p>
                <div className="settings-modal__slider-row">
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={inputVolume}
                    onChange={(e) => setInputVolume(Number(e.target.value))}
                    className="settings-modal__slider"
                    style={{ '--slider-pct': `${inputVolume / 2}%` } as React.CSSProperties}
                  />
                  <span className="settings-modal__slider-value">{inputVolume}%</span>
                </div>
              </div>
              <div>
                <p className="settings-modal__hint" style={{ marginBottom: '4px' }}>output volume</p>
                <div className="settings-modal__slider-row">
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={outputVolume}
                    onChange={(e) => setOutputVolume(Number(e.target.value))}
                    className="settings-modal__slider"
                    style={{ '--slider-pct': `${outputVolume / 2}%` } as React.CSSProperties}
                  />
                  <span className="settings-modal__slider-value">{outputVolume}%</span>
                </div>
              </div>
            </div>
          </section>

          <section style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
            <p className="settings-modal__section-title">updates</p>
            <div className="settings-modal__version-row">
              <span className="settings-modal__version-text">Kizuna v{appVersion}{isDev ? ' (dev)' : ''}</span>
              <button
                onClick={() => checkForUpdates()}
                disabled={updateState === 'checking' || updateState === 'downloading'}
                className="settings-modal__check-btn"
              >
                {updateState === 'checking' ? 'checking...' : updateState === 'downloading' ? `${updateProgress}%` : 'check for updates'}
              </button>
            </div>
            {updateState === 'ready' && (
              <p className="settings-modal__alert settings-modal__alert--success">
                update {updateVersion} ready — restart to apply
              </p>
            )}
            {updateState === 'error' && (
              <p className="settings-modal__alert settings-modal__alert--error">
                {updateError || 'update check failed'}
              </p>
            )}
          </section>
        </div>

        <div className="settings-modal__footer">
          <button onClick={onClose} className="settings-modal__done-btn">done</button>
        </div>
      </div>
    </div>
  )
}
