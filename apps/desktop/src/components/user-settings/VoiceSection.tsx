import { useEffect, useState, useCallback, useRef } from 'react'
import { useVoiceStore, type VoiceInputMode, type VoiceProcessingMode } from '../../store/voiceStore'
import { isTauri, isMobileTauri } from '../../utils/platform'
import { SettingsToggleRow, SettingsSlider } from './rows'

interface AudioDataPayload {
  samples_f32: number[]
  sample_rate: number
  channels: number
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

// The push-to-talk key-capture listener lives in the modal shell (it must
// coexist with the shell's Escape-to-close handling), so listening state
// comes in as props.
export function VoiceSection({
  listeningForKey,
  setListeningForKey,
}: {
  listeningForKey: boolean
  setListeningForKey: (v: boolean) => void
}) {
  const {
    audioInputDeviceId, setAudioInputDeviceId,
    audioOutputDeviceId, setAudioOutputDeviceId,
    voiceInputMode, setVoiceInputMode,
    pushToTalkKey,
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

  const [inputDevices, setInputDevices] = useState<AudioDevice[] | null>(null)
  const [outputDevices, setOutputDevices] = useState<AudioDevice[] | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [monitoring, setMonitoring] = useState(false)
  const unmountedRef = useRef(false)
  const audioLevelCleanupRef = useRef<(() => void) | null>(null)

  // Desktop Tauri runs the Rust DSP chain (RNNoise); web and mobile Tauri use
  // the browser's built-in getUserMedia processing instead — label honestly.
  const nativeVoice = isTauri() && !isMobileTauri()

  const meterLevel = Math.min(100, Math.round((liveAudioLevel / 40) * 100))

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

  return (
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
              {voiceProcessingMode === 'custom' && noiseGateEnabled
                ? 'bar = your live mic level · marker = gate threshold'
                : 'bar = your live mic level'}
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
  )
}
