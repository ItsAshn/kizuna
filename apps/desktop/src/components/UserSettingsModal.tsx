import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Mic, Eye, Database, Download } from 'lucide-react'
import { useVoiceStore, type VoiceInputMode, type VoiceProcessingMode } from '../store/voiceStore'
import { useSettingsStore } from '../store/settingsStore'
import { useServerStore } from '../store/serverStore'
import { useUpdaterActions } from '../hooks/useUpdater'
import { isTauri, isMobileTauri } from '../utils/platform'
import { clearCryptoState } from '../store/keyStore'
import Modal from './ui/Modal'
import ToggleSwitch from './ui/ToggleSwitch'
import SettingsLayout, { type SettingsNavGroup } from './ui/SettingsLayout'
import Slider from './ui/Slider'
import Button from './ui/Button'
import Input from './ui/Input'
import { ActivityIcon } from '../utils/activity'
import type { UserActivity } from '@kizuna/shared'
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

const SECTION_LABELS: Record<string, string> = {
  voice: 'voice',
  privacy: 'privacy',
  data: 'data',
  updates: 'updates',
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

  // Desktop Tauri runs the Rust DSP chain (RNNoise); web and mobile Tauri use
  // the browser's built-in getUserMedia processing instead — label honestly.
  const nativeVoice = isTauri() && !isMobileTauri()

  const navGroups = useMemo<SettingsNavGroup[]>(() => {
    const tauri = isTauri()
    return [
      {
        label: 'media',
        items: [{ key: 'voice', label: 'voice', icon: <Mic size={15} /> }],
      },
      {
        label: 'app',
        items: [
          ...(tauri ? [{ key: 'privacy', label: 'privacy', icon: <Eye size={15} /> }] : []),
          { key: 'data', label: 'data', icon: <Database size={15} /> },
          ...(tauri ? [{ key: 'updates', label: 'updates', icon: <Download size={15} /> }] : []),
        ],
      },
    ]
  }, [])

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

  // `probe` allows a short-lived getUserMedia capture to unlock device labels
  // when the browser hasn't granted mic permission yet. Opening any capture
  // makes some platforms pause other apps' audio, so this is never done
  // implicitly — only from the explicit "detect audio devices" button.
  const loadDevices = useCallback(async (probe = false) => {
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
      const enumerate = () => Promise.race([
        navigator.mediaDevices.enumerateDevices(),
        new Promise<MediaDeviceInfo[]>((_, reject) =>
          setTimeout(() => reject(new Error('Device enumeration timed out')), 3000)
        ),
      ])
      const applyDevices = (devices: MediaDeviceInfo[]) => {
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
      }

      try {
        const devices = await enumerate()
        const hasLabels = devices.some(d => d.kind === 'audioinput' && d.label)
        if (hasLabels) {
          // Mic permission already granted — labels come free, no capture.
          if (!unmountedRef.current) applyDevices(devices)
        } else if (probe) {
          try {
            // Echo cancellation opens the capture in the OS communications
            // path, which pauses other apps' audio — keep all processing off
            // for this label-unlock probe; the stream is stopped immediately.
            const stream = await Promise.race([
              navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
              }),
              new Promise<MediaStream>((_, reject) =>
                setTimeout(() => reject(new Error('Permission request timed out')), 3000)
              ),
            ])
            stream.getTracks().forEach(t => t.stop())
            if (unmountedRef.current) return
            const labeled = await enumerate()
            if (!unmountedRef.current) applyDevices(labeled)
          } catch (err) {
            console.error('Failed to get user media for device labels:', err)
            if (!unmountedRef.current) setPermissionDenied(true)
          }
        }
        // No labels and no probe requested: leave the device list null so the
        // "detect audio devices" button is shown instead of grabbing the mic.
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err)
        if (!unmountedRef.current) {
          setInputDevices([])
          setOutputDevices([])
        }
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

  // Renders the "currently sharing" preview + custom-activity controls shared by
  // the app and media sections. Defined as a plain render helper (not a nested
  // component) so the <Input> keeps focus across re-renders while typing.
  const renderActivitySharing = (opts: {
    kind: 'app' | 'media'
    customActivity: string | null
    setCustomActivity: (v: string | null) => void
    customInput: string
    setCustomInput: (v: string) => void
  }) => {
    const { kind, customActivity, setCustomActivity, customInput, setCustomInput } = opts
    const userId = session?.user.id
    const ownActivity = userId ? userActivities[userId] : undefined
    const matchTypes = kind === 'app' ? ['game', 'app'] : ['music', 'video']
    const current = ownActivity && matchTypes.includes(ownActivity.type) ? ownActivity : undefined
    const previewActivity: UserActivity | null = current
      ? current
      : customActivity
        ? { type: 'other', name: customActivity }
        : null

    const commit = (val: string) => setCustomActivity(val.trim() || null)

    return (
      <div className="settings-activity-card">
        <div className="settings-activity-current">
          <span className="settings-activity-current-label">currently sharing</span>
          {previewActivity ? (
            <div className="settings-activity-now">
              <span className={`settings-activity-now-icon${previewActivity.icon ? ' settings-activity-now-icon--img' : ''}`}>
                <ActivityIcon activity={previewActivity} size={16} className="settings-activity-now-img" />
              </span>
              <span className="settings-activity-now-name">{previewActivity.name}</span>
              {!current && <span className="settings-activity-now-tag">custom</span>}
            </div>
          ) : (
            <span className="settings-activity-empty">nothing detected</span>
          )}
        </div>

        <div className="settings-activity-custom">
          <Input
            className="settings-activity-input"
            placeholder="set a custom activity…"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(customInput) }}
          />
          <Button size="sm" onClick={() => commit(customInput)} disabled={!customInput.trim()}>set</Button>
          {customActivity && (
            <Button size="sm" variant="danger" onClick={() => { setCustomActivity(null); setCustomInput('') }}>clear</Button>
          )}
        </div>

        {runningWindows.length > 0 && (
          <div className="settings-activity-suggestions">
            <span className="settings-activity-suggestions-label">running apps</span>
            <div className="settings-activity-chips">
              {runningWindows.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`settings-activity-chip${customActivity === name ? ' settings-activity-chip--active' : ''}`}
                  onClick={() => { setCustomInput(name); setCustomActivity(name) }}
                  title={name}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

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
      <SettingsLayout
        groups={navGroups}
        activeKey={activeTab}
        onChange={setActiveTab}
        activeLabel={SECTION_LABELS[activeTab]}
      >

      {/* ── Voice ─────────────────────────────────────────── */}

      {activeTab === 'voice' && (
        <div className="settings-tab-content">

          {permissionDenied && (
            <p className="settings-permission-warning">
              microphone permission denied — device labels unavailable
            </p>
          )}

          {/* Audio devices */}
          <div className="settings-card">
            <p className="settings-card-title">audio devices</p>
            {inputDevices === null ? (
              <button
                onClick={() => loadDevices(true)}
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
                {
                  id: 'standard',
                  label: 'standard',
                  desc: nativeVoice
                    ? 'rnnoise suppression + auto leveler · recommended'
                    : 'browser noise suppression + auto leveler · recommended',
                },
                { id: 'custom', label: 'custom', desc: 'tune each filter yourself' },
              ] as { id: VoiceProcessingMode; label: string; desc: string }[]).map((m) => (
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
                {nativeVoice
                  ? 'rnnoise (ai) noise suppression removes steady background noise like fans and hum, with a gentle auto-leveler. pick custom to fine-tune the gate, suppression, and gain yourself.'
                  : "your browser's built-in noise suppression removes steady background noise like fans and hum, with automatic gain. pick custom to fine-tune the gate, suppression, and gain yourself."}
              </p>
            )}

            {voiceProcessingMode === 'custom' && (
              <>
                <div className="settings-processing-item">
                  <p className="settings-processing-item-title">noise suppression</p>
                  <SettingsToggleRow
                    label={`enable suppression (${nativeVoice ? 'rnnoise' : 'browser'})`}
                    checked={noiseSuppression}
                    onChange={setNoiseSuppression}
                    ariaLabel="enable noise suppression"
                    hint={nativeVoice
                      ? 'ai-based removal of steady background noise like fans and hum. runs at full strength'
                      : "your browser's built-in removal of steady background noise like fans and hum"}
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

            {shareAppActivity && renderActivitySharing({
              kind: 'app',
              customActivity: customAppActivity,
              setCustomActivity: setCustomAppActivity,
              customInput: customAppInput,
              setCustomInput: setCustomAppInput,
            })}

            {shareMediaActivity && renderActivitySharing({
              kind: 'media',
              customActivity: customMediaActivity,
              setCustomActivity: setCustomMediaActivity,
              customInput: customMediaInput,
              setCustomInput: setCustomMediaInput,
            })}
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
      </SettingsLayout>
    </Modal>
  )
}
