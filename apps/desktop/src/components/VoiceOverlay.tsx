import { useState, useCallback, useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import type { ConnectionQuality } from '@kizuna/shared'
import { Volume2, Mic, MicOff, PhoneOff, Monitor, MonitorOff, Video, VideoOff } from 'lucide-react'
import MonitorPicker from './MonitorPicker'
import Slider from './ui/Slider'
import { useMobile } from '../hooks/useMobile'
import { getVoiceLogLines } from '../hooks/useVoice'
import './VoiceOverlay.css'

interface VoiceOverlayProps {
  leaveVoice: () => void
  toggleMute: () => void
  socketRef: React.MutableRefObject<Socket | null>
  startScreenshare: (channelId: string, monitorIndex: number, fps: number) => Promise<string | null>
  stopScreenshare: () => void
  dmCallOtherUsername?: string | null
  toggleCamera?: (channelId: string) => void
  isCameraOn?: boolean
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

export default function VoiceOverlay({ leaveVoice, toggleMute, startScreenshare, stopScreenshare, dmCallOtherUsername, toggleCamera, isCameraOn }: VoiceOverlayProps) {
  const {
    channels,
  } = useChatStore()
  const {
    activeVoiceChannelId,
    voicePeers,
    isMuted,
    isSpeaking,
    localConnectionQuality,
    serverVoiceBitrateKbps,
    voiceError,
    setVoiceError,
    peerVolumes,
    setPeerVolume,
  } = useVoiceStore()
  const {
    isScreenSharing,
    screenSharePeerId,
  } = useCallStore()
  const [closing, setClosing] = useState(false)
  const [showMonitorPicker, setShowMonitorPicker] = useState(false)
  const [screenShareError, setScreenShareError] = useState<string | null>(null)
  const isMobile = useMobile()
  useEffect(() => {
    if (activeVoiceChannelId) setClosing(false)
  }, [activeVoiceChannelId])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showMonitorPicker && activeVoiceChannelId) {
        setClosing(true)
        setTimeout(() => {
          setVoiceError(null)
          leaveVoice()
          setClosing(false)
        }, 250)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [showMonitorPicker, activeVoiceChannelId])

  const handleLeave = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setVoiceError(null)
      leaveVoice()
      setClosing(false)
    }, 250)
  }, [leaveVoice, setVoiceError])

  // Publish the call sheet's height so the mobile chat column can reserve
  // space for it (it's a fixed bottom sheet there) and not hide the composer.
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const overlayShown = !!(activeVoiceChannelId || voiceError || closing)
  useEffect(() => {
    const root = document.documentElement
    const el = overlayRef.current
    if (!overlayShown || !el) {
      root.style.removeProperty('--voice-sheet-h')
      return
    }
    const update = () => root.style.setProperty('--voice-sheet-h', `${el.offsetHeight}px`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.removeProperty('--voice-sheet-h')
    }
  }, [overlayShown])

  if (!activeVoiceChannelId && !voiceError && !closing) return null

  const channel = channels.find(c => c.id === activeVoiceChannelId)
  const isDMCall = !!dmCallOtherUsername
  const headerName = isDMCall ? dmCallOtherUsername : (channel?.name || 'Voice Channel')
  const headerIcon = isDMCall ? (dmCallOtherUsername?.[0]?.toUpperCase()) : ''

  const handleRetry = () => {
    setVoiceError(null)
  }

  return (
    <div ref={overlayRef} className={`voice-overlay${closing ? ' voice-overlay--closing' : ''}`}>
      {voiceError && (
        <div className="voice-error">
          <div className="voice-error__label">Voice Error</div>
          <p className="voice-error__message">{voiceError}</p>
          <details className="voice-error__debug">
            <summary className="voice-error__debug-summary">debug log</summary>
            <pre className="voice-error__debug-log">{getVoiceLogLines().join('\n')}</pre>
          </details>
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
        {isDMCall ? (
          <div className="voice-peer__avatar voice-peer__avatar--dmcall">
            {headerIcon}
          </div>
        ) : (
          <Volume2 className="icon-xs voice-header__icon" />
        )}
        <span className="voice-header__name">
          {headerName}
        </span>
        <span className={`voice-header__status ${voiceError ? 'voice-header__status--error' : ''}`}>
          {voiceError ? 'error' : 'connected'}
        </span>
        {!voiceError && (
          <>
            {!isDMCall && !isMobile && '__TAURI_INTERNALS__' in window && (
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
              aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? <MicOff className="icon-xs" /> : <Mic className="icon-xs" />}
            </button>
            {toggleCamera && (
              <button
                onClick={() => toggleCamera(activeVoiceChannelId!)}
                className={`voice-header__btn ${isCameraOn ? 'voice-header__btn--camera-active' : 'voice-header__btn--camera'}`}
                title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
                aria-label={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
              >
                {isCameraOn ? <Video className="icon-xs" /> : <VideoOff className="icon-xs" />}
              </button>
            )}
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
              <div className="voice-peer__volume">
                <Slider
                  size="sm"
                  min={0}
                  max={200}
                  value={peerVolumes[peer.id] ?? 100}
                  onChange={(value) => setPeerVolume(peer.id, value)}
                  ariaLabel={`Volume for ${peer.username}`}
                />
              </div>
              {peer.muted && (
                <span className="voice-peer__peer-muted">Muted</span>
              )}
            </div>
          ))}
      </div>

      {!voiceError && (
        <div className="voice-footer">
          <span>{serverVoiceBitrateKbps} kbps</span>
        </div>
      )}
    </div>
  )
}
