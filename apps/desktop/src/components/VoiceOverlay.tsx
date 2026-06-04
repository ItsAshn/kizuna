import { useState, useCallback, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'
import type { ConnectionQuality } from '@kizuna/shared'
import { Volume2, Mic, MicOff, PhoneOff, Monitor, MonitorOff } from 'lucide-react'
import MonitorPicker from './MonitorPicker'
import '../styles/voice-overlay.css'

interface VoiceOverlayProps {
  leaveVoice: () => void
  toggleMute: () => void
  setAudioBitrate: (socket: any, kbps: number) => void
  socketRef: React.MutableRefObject<any>
  startScreenshare: (channelId: string, monitorIndex: number, fps: number) => Promise<string | null>
  stopScreenshare: () => void
}

function ConnectionQualityBars({ quality }: { quality: ConnectionQuality | null | undefined }) {
  const barCount =
    quality === 'good' ? 3
    : quality === 'fair' ? 2
    : quality === 'poor' ? 1
    : 0
  const colorClass =
    quality === 'good' ? 'voice-connection-bar--good'
    : quality === 'fair' ? 'voice-connection-bar--fair'
    : quality === 'poor' ? 'voice-connection-bar--poor'
    : ''
  const heights = ['voice-connection-bar--h-sm', 'voice-connection-bar--h-md', 'voice-connection-bar--h-lg']
  return (
    <span
      className="voice-connection-bars"
      title={quality ? `Connection: ${quality}` : 'Measuring connection...'}
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className={`voice-connection-bar ${h} ${i < barCount ? colorClass : ''}`}
        />
      ))}
    </span>
  )
}

export default function VoiceOverlay({ leaveVoice, toggleMute, setAudioBitrate, socketRef, startScreenshare, stopScreenshare }: VoiceOverlayProps) {
  const {
    activeVoiceChannelId,
    voicePeers,
    isMuted,
    isSpeaking,
    channels,
    localConnectionQuality,
    audioBitrateKbps,
    voiceError,
    isScreenSharing,
    screenSharePeerId,
    setVoiceError,
  } = useChatStore()
  const [closing, setClosing] = useState(false)
  const [showMonitorPicker, setShowMonitorPicker] = useState(false)
  const [screenShareError, setScreenShareError] = useState<string | null>(null)

  useEffect(() => {
    if (activeVoiceChannelId) setClosing(false)
  }, [activeVoiceChannelId])

  const handleLeave = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setVoiceError(null)
      leaveVoice()
    }, 250)
  }, [leaveVoice, setVoiceError])

  if (!activeVoiceChannelId && !closing) return null

  const channel = channels.find(c => c.id === activeVoiceChannelId)

  const handleRetry = () => {
    setVoiceError(null)
  }

  return (
    <div className={`voice-overlay${closing ? ' voice-overlay--closing' : ''}`}>
      {voiceError && (
        <div className="voice-error">
          <div className="voice-error__label">Voice Error</div>
          <p className="voice-error__message">{voiceError}</p>
          <div className="voice-error__actions">
            <button onClick={handleRetry} className="voice-error__btn voice-error__btn--retry">
              retry
            </button>
            <button onClick={handleLeave} className="voice-error__btn voice-error__btn--leave">
              leave
            </button>
          </div>
        </div>
      )}

      <div className="voice-header">
        <Volume2 className="icon-xs voice-header__icon" />
        <span className="voice-header__name">
          {channel?.name || 'Voice Channel'}
        </span>
        <span className={`voice-header__status ${voiceError ? 'voice-header__status--error' : ''}`}>
          {voiceError ? 'error' : 'connected'}
        </span>
        {!voiceError && (
          <>
            {'__TAURI_INTERNALS__' in window && (
              <button
                onClick={() => {
                  if (isScreenSharing) {
                    stopScreenshare()
                    setScreenShareError(null)
                  } else if (screenSharePeerId) {
                    setScreenShareError('Someone else is already sharing')
                  } else {
                    setShowMonitorPicker(true)
                  }
                }}
                className={`voice-header__btn ${isScreenSharing ? 'voice-header__btn--screenshare-active' : 'voice-header__btn--screenshare'}`}
                title={isScreenSharing ? 'Stop sharing' : screenSharePeerId ? 'Someone else is sharing' : 'Share screen'}
                disabled={!!screenSharePeerId && !isScreenSharing}
              >
                {isScreenSharing ? <MonitorOff className="icon-xs" /> : <Monitor className="icon-xs" />}
              </button>
            )}
            <button
              onClick={toggleMute}
              className={`voice-header__btn ${isMuted ? 'voice-header__btn--unmute' : 'voice-header__btn--mute'}`}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff className="icon-xs" /> : <Mic className="icon-xs" />}
            </button>
            <button
              onClick={handleLeave}
              className="voice-header__btn voice-header__btn--leave"
              title="Leave"
            >
              <PhoneOff className="icon-xs" />
            </button>
          </>
        )}
      </div>

      {screenShareError && (
        <div className="voice-error" style={{ marginTop: 0, borderTop: 'none' }}>
          <p className="voice-error__message">{screenShareError}</p>
          <button onClick={() => setScreenShareError(null)} className="voice-error__btn voice-error__btn--retry" style={{ marginTop: 4 }}>
            dismiss
          </button>
        </div>
      )}

      {showMonitorPicker && (
        <MonitorPicker
          onSelect={async (monitorIndex) => {
            setShowMonitorPicker(false)
            if (!activeVoiceChannelId) return
            const err = await startScreenshare(activeVoiceChannelId, monitorIndex, 15)
            if (err) setScreenShareError(err)
          }}
          onCancel={() => setShowMonitorPicker(false)}
        />
      )}

      <div className="voice-body">
        {!voiceError && (
          <div className="voice-peer">
            <div className="voice-peer__avatar-wrap">
              {isSpeaking && !isMuted && (
                <span className="voice-peer__speaking-ring" />
              )}
              <div className={`voice-peer__avatar ${
                isMuted ? 'voice-peer__avatar--muted'
                  : isSpeaking ? 'voice-peer__avatar--speaking'
                  : 'voice-peer__avatar--idle'
              }`}>
                <span>
                  {(channel?.name || 'You')[0]?.toUpperCase()}
                </span>
              </div>
            </div>
            <span className={`voice-peer__name ${
              isSpeaking && !isMuted ? 'voice-peer__name--speaking' : 'voice-peer__name--default'
            }`}>
              You
            </span>
            <ConnectionQualityBars quality={localConnectionQuality} />
            <span className="voice-peer__mute-label">{isMuted ? 'Muted' : ''}</span>
          </div>
        )}

        {!voiceError &&
          voicePeers.map((peer) => (
            <div key={peer.id} className="voice-peer">
              <div className="voice-peer__avatar-wrap">
                {peer.speaking && !peer.muted && (
                  <span className="voice-peer__speaking-ring" />
                )}
                <div className={`voice-peer__avatar ${
                  peer.muted ? 'voice-peer__avatar--peer-muted'
                    : peer.speaking ? 'voice-peer__avatar--peer-speaking'
                    : 'voice-peer__avatar--peer-idle'
                }`}>
                  <span>{peer.username?.[0]?.toUpperCase()}</span>
                </div>
              </div>
              <span className={`voice-peer__name ${
                peer.speaking && !peer.muted ? 'voice-peer__name--peer-speaking' : 'voice-peer__name--peer'
              }`}>
                {peer.username}
              </span>
              <ConnectionQualityBars quality={peer.connectionQuality} />
              {peer.muted && (
                <span className="voice-peer__peer-muted">Muted</span>
              )}
            </div>
          ))}
      </div>

      {!voiceError && (
        <div className="voice-bitrate">
          <span className="voice-bitrate__label">
            bitrate
          </span>
          <select
            value={audioBitrateKbps}
            onChange={(e) => {
              const kbps = Number(e.target.value)
              if (socketRef.current) setAudioBitrate(socketRef.current, kbps)
            }}
            className="voice-bitrate__select"
          >
            <option value={32}>32 kbps</option>
            <option value={64}>64 kbps</option>
            <option value={96}>96 kbps</option>
            <option value={128}>128 kbps</option>
            <option value={192}>192 kbps</option>
            <option value={256}>256 kbps</option>
            <option value={320}>320 kbps</option>
          </select>
        </div>
      )}
    </div>
  )
}
