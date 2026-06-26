import { useEffect, useState, useCallback, useRef } from 'react'
import { useVoiceStore, type VoiceInputMode } from '../store/voiceStore'
import { useSettingsStore } from '../store/settingsStore'
import { useServerStore } from '../store/serverStore'
import { useUpdaterActions } from '../hooks/useUpdater'
import { isTauri, isMobileTauri } from '../utils/platform'
import { clearCryptoState } from '../store/keyStore'
import Modal from './ui/Modal'
import ToggleSwitch from './ui/ToggleSwitch'
import Tabs from './ui/Tabs'
import Slider from './ui/Slider'
import './UserSettingsModal.css'

interface AudioDataPayload {
  samples_f32: number[]
  sample_rate: number
  channels: number
}

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

const INPUT_MODES: { value: VoiceInputMode; label: string; desc: string }[] = [
  { value: 'voice-activity', label: 'voice activity', desc: 'automatically transmit when you speak' },
  { value: 'push-to-talk', label: 'push to talk', desc: 'hold a key to transmit' },
]

const TABS = [
  { key: 'voice', label: 'voice' },
  ...(isTauri() ? [{ key: 'privacy', label: 'privacy' }] : []),
  { key: 'data', label: 'data' },
  ...(isTauri() ? [{ key: 'updates', label: 'updates' }] : []),
]

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

// ── Local sub-components ──────────────────────────────────────

function SettingsToggleRow({
  label,
  hint,
  checked,
  onChange,
  ariaLabel,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
}) {
  return (
    <div className="settings-toggle-row">
      <div>
        <div className="settings-toggle-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={ariaLabel} />
    </div>
  )
}

function SettingsSlider({
  label,
  min,
  max,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <div className="settings-slider-control">
      <div className="settings-slider-row">
        <span className="settings-slider-label">{label}</span>
        <Slider
          min={min}
          max={max}
          value={value}
          onChange={onChange}
          fillFromStart
          style={{ flex: 1 }}
          disabled={disabled}
          ariaLabel={label}
        />
        <span className="settings-slider-value">{value}%</span>
      </div>
      {hint && <div className="settings-hint">{hint}</div>}
    </div>
  )
}

function SettingsActionRow({
  label,
  hint,
  buttonLabel,
  onClick,
  danger,
  dangerConfirm,
  onCancel,
}: {
  label: string
  hint?: string
  buttonLabel: string
  onClick: () => void
  danger?: boolean
  dangerConfirm?: boolean
  onCancel?: () => void
}) {
  let btnClass = 'settings-btn'
  if (dangerConfirm) btnClass += ' settings-btn--danger-confirm'
  else if (danger) btnClass += ' settings-btn--danger'

  return (
    <div className="settings-action-row">
      <div>
        <div className="settings-toggle-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-action-buttons">
        {dangerConfirm ? (
          <>
            <button onClick={onClick} className={btnClass}>
              confirm
            </button>
            <button onClick={onCancel} className="settings-btn">
              cancel
            </button>
          </>
        ) : (
          <button onClick={onClick} className={btnClass}>
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────

export default function UserSettingsModal({ onClose }: Props) {
  const {
    audioInputDeviceId, setAudioInputDeviceId,
    audioOutputDeviceId, setAudioOutputDeviceId,
    voiceInputMode, setVoiceInputMode,
    pushToTalkKey, setPushToTalkKey,
    voiceProcessingMode, setVoiceProcessingMode,
    noiseSuppression, setNoiseSuppression,
    autoGainControl, setAutoGainControl,
    echoCancellation, setEchoCancellation,
    noiseGateEnabled, setNoiseGateEnabled,
    noiseGateThreshold, setNoiseGateThreshold,
    inputVolume, setInputVolume,
    outputVolume, setOutputVolume,
    liveAudioLevel, setLiveAudioLevel,
  } = useVoiceStore()
  const {
    updateState, updateProgress, updateVersion, updateError,
    shareAppActivity, setShareAppActivity,
    customAppActivity, setCustomAppActivity,
    shareMediaActivity, setShareMediaActivity,
    customMediaActivity, setCustomMediaActivity,
  } = useSettingsStore()
  const userActivities = useVoiceStore((s) => s.userActivities)
  const session = useServerStore((s) => s.activeSession)
  const { checkForUpdates, installUpdate, getVersion } = useUpdaterActions()

  const [activeTab, setActiveTab] = useState('voice')
  const [inputDevices, setInputDevices] = useState<AudioDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<AudioDevice[] | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [appVersion, setAppVersion] = useState('0.1.0')
  const [isDev, setIsDev] = useState(true)
  const [listeningForKey, setListeningForKey] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const [customAppInput, setCustomAppInput] = useState('')
  const [customMediaInput, setCustomMediaInput] = useState('')
  const [runningWindows, setRunningWindows] = useState<string[]>([])
  const unmountedRef = useRef(false)
  const audioLevelCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (activeTab !== 'privacy' || !isTauri() || unmountedRef.current) return
    let cancelled = false
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<{ title: string; process_name: string; display_name: string }[]>('list_windows')
        .then((windows) => {
          if (cancelled || unmountedRef.current) return
          const names = windows
            .map((w) => w.display_name || w.title)
            .filter((t): t is string => !!t && t.trim().length > 0)
          setRunningWindows([...new Set(names)])
        })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [activeTab])

  const meterLevel = Math.min(100, Math.round((liveAudioLevel / 40) * 100))

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
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err)
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
      } catch (err) {
        console.error('Failed to get user media for device labels:', err)
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

  const startAudioMonitoring = useCallback(async () => {
    audioLevelCleanupRef.current?.()

    if (!isTauri()) return

    const { invoke } = await import('@tauri-apps/api/core')
    const { listen } = await import('@tauri-apps/api/event')

    try { await invoke('stop_audio_capture') } catch (err) { console.error('Failed to stop prior audio capture:', err) }

    try {
      await invoke('start_audio_capture', {
        deviceName: audioInputDeviceId ?? null,
        sampleRate: 48000,
        channels: 1,
      })
    } catch (e) {
      console.error('settings: start_audio_capture failed', e)
      return
    }

    const unlisten = await listen<AudioDataPayload>('audio:data', (event) => {
      const samples = event.payload.samples_f32
      if (!samples || samples.length === 0) return
      const sumSq = samples.reduce((sum, s) => sum + s * s, 0)
      const rms = Math.sqrt(sumSq / samples.length)
      setLiveAudioLevel(rms * 1000)
    })

    audioLevelCleanupRef.current = () => {
      unlisten()
      invoke('stop_audio_capture').catch((err) => { console.error('Failed to stop audio capture on cleanup:', err) })
    }
  }, [audioInputDeviceId, setLiveAudioLevel])

  useEffect(() => {
    if (!monitoring) return
    startAudioMonitoring()
    return () => {
      audioLevelCleanupRef.current?.()
      audioLevelCleanupRef.current = null
      setLiveAudioLevel(0)
    }
  }, [monitoring, audioInputDeviceId, startAudioMonitoring, setLiveAudioLevel])

  const handleResetAudio = useCallback(() => {
    setAudioInputDeviceId(null)
    setAudioOutputDeviceId(null)
  }, [setAudioInputDeviceId, setAudioOutputDeviceId])

  const handleResetDatabase = useCallback(() => {
    clearCryptoState()
    localStorage.removeItem('kizuna-voice-settings')
    localStorage.removeItem('kizuna-servers')
    window.location.reload()
  }, [])

  // ── Render ──────────────────────────────────────────────────

  return (
    <Modal
      open
      onClose={onClose}
      title="// user settings"
      className="settings-modal"
      footer={(handleClose) => (
        <button onClick={handleClose} className="settings-modal__done-btn">done</button>
      )}
    >
      {permissionDenied && (
        <p className="settings-permission-warning">
          microphone permission denied — device labels unavailable
        </p>
      )}

      <Tabs tabs={TABS} activeKey={activeTab} onChange={setActiveTab} variant="underline" />

      {/* ── Voice ─────────────────────────────────────────── */}

      {activeTab === 'voice' && (
        <div className="settings-tab-content">

          {/* Audio devices */}
          <div className="settings-card">
            <p className="settings-card-title">audio devices</p>
            {inputDevices === null ? (
              <button
                onClick={loadDevices}
                disabled={devicesLoading}
                className="settings-btn settings-btn--block"
              >
                {devicesLoading ? 'detecting...' : 'detect audio devices'}
              </button>
            ) : (
              <>
                <p className="settings-select-label">input (microphone)</p>
                <select
                  value={audioInputDeviceId ?? ''}
                  onChange={(e) => setAudioInputDeviceId(e.target.value || null)}
                  className="settings-select"
                >
                  <option value="">system default</option>
                  {inputDevices.map(d => (
                    <option key={d.device_id} value={d.device_id}>
                      {d.name}{d.is_default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <p className="settings-select-label">output (speakers / headphones)</p>
                {outputDevices && outputDevices.length > 0 ? (
                  <select
                    value={audioOutputDeviceId ?? ''}
                    onChange={(e) => setAudioOutputDeviceId(e.target.value || null)}
                    className="settings-select"
                  >
                    <option value="">system default</option>
                    {outputDevices.map(d => (
                      <option key={d.device_id} value={d.device_id}>
                        {d.name}{d.is_default ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="settings-alert settings-alert--info">
                    output device selection not supported in this environment
                  </p>
                )}
              </>
            )}
          </div>

          {/* Input mode */}
          <div className="settings-card">
            <p className="settings-card-title">input mode</p>
            <div className="settings-radio-group">
              {INPUT_MODES.map(mode => (
                <button
                  key={mode.value}
                  className={`settings-radio-option${voiceInputMode === mode.value ? ' settings-radio-option--active' : ''}`}
                  onClick={() => setVoiceInputMode(mode.value)}
                  type="button"
                >
                  <span className="settings-radio-dot" />
                  <div>
                    <div className="settings-radio-label">{mode.label}</div>
                    <div className="settings-radio-desc">{mode.desc}</div>
                  </div>
                </button>
              ))}
            </div>
            {voiceInputMode === 'push-to-talk' && (
              <div className="settings-keybind-row">
                <span className="settings-keybind-label">shortcut</span>
                <button
                  className={`settings-keybind-btn${listeningForKey ? ' settings-keybind-btn--listening' : ''}`}
                  onClick={() => setListeningForKey(true)}
                  onBlur={() => setListeningForKey(false)}
                >
                  {listeningForKey ? 'press a key...' : keyCodeToLabel(pushToTalkKey)}
                </button>
              </div>
            )}
          </div>

          {/* Audio processing */}
          <div className="settings-card">
            <p className="settings-card-title">audio processing</p>

            <div
              className="settings-mode-selector"
              role="radiogroup"
              aria-label="audio processing mode"
            >
              {([
                { id: 'off', label: 'off', desc: 'raw mic — no processing' },
                { id: 'standard', label: 'standard', desc: 'rnnoise suppression + auto leveler · recommended' },
                { id: 'custom', label: 'custom', desc: 'tune each filter yourself' },
              ] as const).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={voiceProcessingMode === m.id}
                  onClick={() => setVoiceProcessingMode(m.id)}
                  className={`settings-mode-btn${voiceProcessingMode === m.id ? ' settings-mode-btn--active' : ''}`}
                >
                  <span className="settings-mode-btn-label">{m.label}</span>
                  <span className="settings-mode-btn-desc">{m.desc}</span>
                </button>
              ))}
            </div>

            <div className="settings-mic-test">
              <button
                onClick={() => setMonitoring((m) => !m)}
                className="settings-btn"
              >
                {monitoring ? 'stop mic test' : 'test microphone'}
              </button>
              <div className="settings-meter-row">
                <div className="settings-meter-bar">
                  <div
                    className={`settings-meter-fill${meterLevel < 25 ? ' settings-meter-fill--low' : meterLevel < 55 ? ' settings-meter-fill--mid' : ' settings-meter-fill--high'}`}
                    style={{ width: `${meterLevel}%` }}
                  />
                  {voiceProcessingMode === 'custom' && noiseGateEnabled && (
                    <div
                      className="settings-meter-threshold"
                      style={{ left: `${noiseGateThreshold}%` }}
                    />
                  )}
                </div>
                <div className="settings-meter-hint">
                  green bar = your current mic level
                </div>
              </div>
            </div>

            {voiceProcessingMode === 'standard' && (
              <p className="settings-hint">
                rnnoise (ai) noise suppression removes steady background noise like fans and hum, with a gentle auto-leveler. pick custom to fine-tune the gate, suppression, and gain yourself.
              </p>
            )}

            {voiceProcessingMode === 'custom' && (
              <>
                <div className="settings-processing-item">
                  <p className="settings-processing-item-title">noise suppression</p>
                  <SettingsToggleRow
                    label="enable suppression (rnnoise)"
                    checked={noiseSuppression}
                    onChange={setNoiseSuppression}
                    ariaLabel="enable noise suppression"
                    hint="ai-based removal of steady background noise like fans and hum. runs at full strength"
                  />
                </div>

                <div className="settings-processing-item">
                  <p className="settings-processing-item-title">noise gate</p>
                  <SettingsToggleRow
                    label="enable noise gate"
                    checked={noiseGateEnabled}
                    onChange={setNoiseGateEnabled}
                    ariaLabel="enable noise gate"
                    hint="silences the mic below a volume threshold. usually unnecessary when suppression is on"
                  />
                  <SettingsSlider
                    label="threshold"
                    min={0}
                    max={100}
                    value={noiseGateThreshold}
                    onChange={setNoiseGateThreshold}
                    disabled={!noiseGateEnabled}
                    hint="set the marker above your background noise level"
                  />
                </div>

                <div className="settings-processing-item">
                  <p className="settings-processing-item-title">auto gain control</p>
                  <SettingsToggleRow
                    label="enable auto gain"
                    checked={autoGainControl}
                    onChange={setAutoGainControl}
                    ariaLabel="enable auto gain control"
                    hint="automatically normalizes your microphone volume to a consistent level"
                  />
                </div>

                <div className="settings-processing-item">
                  <p className="settings-processing-item-title">echo cancellation</p>
                  <SettingsToggleRow
                    label="enable echo cancellation"
                    checked={echoCancellation}
                    onChange={setEchoCancellation}
                    ariaLabel="enable echo cancellation"
                    hint="removes echo when using speakers instead of headphones. leaving this off prevents other apps' audio from being paused when you join a voice channel"
                  />
                </div>
              </>
            )}

            <p className="settings-hint settings-processing-note">
              applied on next voice channel join
            </p>
          </div>

          {/* Volume */}
          <div className="settings-card">
            <p className="settings-card-title">volume</p>
            <SettingsSlider
              label="input"
              min={0}
              max={200}
              value={inputVolume}
              onChange={setInputVolume}
            />
            <SettingsSlider
              label="output"
              min={0}
              max={200}
              value={outputVolume}
              onChange={setOutputVolume}
            />
          </div>
        </div>
      )}

      {/* ── Privacy ───────────────────────────────────────── */}

      {activeTab === 'privacy' && (
        <div className="settings-tab-content">
          <div className="settings-card">
            <p className="settings-card-title">activity sharing</p>

            <SettingsToggleRow
              label="share my games &amp; apps"
              hint="show the game or application currently in focus on your desktop"
              checked={shareAppActivity}
              onChange={setShareAppActivity}
            />

            <SettingsToggleRow
              label="share my music &amp; media"
              hint="show the song or video you're currently playing (e.g. Spotify)"
              checked={shareMediaActivity}
              onChange={setShareMediaActivity}
            />

            {shareAppActivity && (() => {
              const userId = session?.user.id
              const ownActivity = userId ? userActivities[userId] : undefined
              const current = ownActivity && (ownActivity.type === 'game' || ownActivity.type === 'app')
                ? ownActivity
                : undefined
              const displayText = current
                ? `${current.type === 'game' ? '\u{1F3AE}' : '\u{1F4BB}'} ${current.name}${current.details ? ' \u2014 ' + current.details : ''}`
                : customAppActivity
                  ? `${customAppActivity} (custom)`
                  : 'nothing detected'

              return (
                <div className="settings-activity-preview">
                  <div className="settings-activity-preview-header">
                    <span className="settings-activity-preview-label">
                      currently sharing: {displayText}
                    </span>
                  </div>
                  <div className="settings-activity-custom">
                    <input
                      className="settings-activity-input"
                      placeholder="type custom activity..."
                      value={customAppInput}
                      onChange={(e) => setCustomAppInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setCustomAppActivity(customAppInput || null)
                        }
                      }}
                    />
                    <button
                      className="settings-btn"
                      onClick={() => setCustomAppActivity(customAppInput || null)}
                      disabled={!customAppInput.trim()}
                    >
                      set
                    </button>
                    {customAppActivity && (
                      <button
                        className="settings-btn settings-btn--danger"
                        onClick={() => { setCustomAppActivity(null); setCustomAppInput('') }}
                      >
                        clear
                      </button>
                    )}
                  </div>
                  {runningWindows.length > 0 && (
                    <div className="settings-activity-suggestions">
                      <span className="settings-activity-suggestions-label">running apps:</span>
                      <select
                        className="settings-activity-select"
                        value=""
                        onChange={(e) => {
                          const val = e.target.value
                          if (val) {
                            setCustomAppInput(val)
                            setCustomAppActivity(val)
                          }
                        }}
                      >
                        <option value="">— choose —</option>
                        {runningWindows.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )
            })()}

            {shareMediaActivity && (() => {
              const userId = session?.user.id
              const ownActivity = userId ? userActivities[userId] : undefined
              const current = ownActivity && (ownActivity.type === 'music' || ownActivity.type === 'video')
                ? ownActivity
                : undefined
              const displayText = current
                ? `${current.type === 'music' ? '\u{1F3B5}' : '\u{1F3AC}'} ${current.name}${current.details ? ' — ' + current.details : ''}`
                : customMediaActivity
                  ? `${customMediaActivity} (custom)`
                  : 'nothing detected'

              return (
                <div className="settings-activity-preview">
                  <div className="settings-activity-preview-header">
                    <span className="settings-activity-preview-label">
                      currently sharing: {displayText}
                    </span>
                  </div>
                  <div className="settings-activity-custom">
                    <input
                      className="settings-activity-input"
                      placeholder="type custom activity..."
                      value={customMediaInput}
                      onChange={(e) => setCustomMediaInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setCustomMediaActivity(customMediaInput || null)
                        }
                      }}
                    />
                    <button
                      className="settings-btn"
                      onClick={() => setCustomMediaActivity(customMediaInput || null)}
                      disabled={!customMediaInput.trim()}
                    >
                      set
                    </button>
                    {customMediaActivity && (
                      <button
                        className="settings-btn settings-btn--danger"
                        onClick={() => { setCustomMediaActivity(null); setCustomMediaInput('') }}
                      >
                        clear
                      </button>
                    )}
                  </div>
                  {runningWindows.length > 0 && (
                    <div className="settings-activity-suggestions">
                      <span className="settings-activity-suggestions-label">running apps:</span>
                      <select
                        className="settings-activity-select"
                        value=""
                        onChange={(e) => {
                          const val = e.target.value
                          if (val) {
                            setCustomMediaInput(val)
                            setCustomMediaActivity(val)
                          }
                        }}
                      >
                        <option value="">— choose —</option>
                        {runningWindows.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* ── Data ──────────────────────────────────────────── */}

      {activeTab === 'data' && (
        <div className="settings-tab-content">
          <div className="settings-card">
            <p className="settings-card-title">local data</p>
            <SettingsActionRow
              label="reset audio devices"
              hint="clear saved microphone and speaker selection"
              buttonLabel="reset"
              onClick={handleResetAudio}
            />
            <SettingsActionRow
              label="reset database"
              hint="clear all local data including sessions and settings"
              buttonLabel="reset"
              onClick={resetConfirm ? handleResetDatabase : () => setResetConfirm(true)}
              danger
              dangerConfirm={resetConfirm}
              onCancel={() => setResetConfirm(false)}
            />
          </div>
        </div>
      )}

      {/* ── Updates ───────────────────────────────────────── */}

      {activeTab === 'updates' && isTauri() && (
        <div className="settings-tab-content">
          <div className="settings-card">
            <p className="settings-card-title">version</p>
            <div className="settings-version-row">
              <span className="settings-version-text">
                Kizuna v{appVersion}{isDev && <span className="settings-version-dev"> (dev)</span>}
              </span>
              <button
                onClick={() => checkForUpdates()}
                disabled={updateState === 'checking' || updateState === 'downloading'}
                className="settings-btn"
              >
                {updateState === 'checking'
                  ? 'checking...'
                  : updateState === 'downloading'
                    ? `${updateProgress}%`
                    : 'check for updates'}
              </button>
            </div>
            {updateState === 'ready' && (
              <div className="settings-version-row">
                <span className="settings-alert settings-alert--success">
                  {isMobileTauri()
                    ? `update ${updateVersion} available`
                    : `update ${updateVersion} ready — restart to apply`}
                </span>
                <button onClick={installUpdate} className="settings-btn">
                  {isMobileTauri() ? 'download' : 'restart now'}
                </button>
              </div>
            )}
            {updateState === 'error' && (
              <p className="settings-alert settings-alert--error">
                {updateError || 'update check failed'}
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
