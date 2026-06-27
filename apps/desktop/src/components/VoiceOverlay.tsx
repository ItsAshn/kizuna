import { useState, useCallback, useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import type { ConnectionQuality } from '@kizuna/shared'
import { Mic, MicOff, PhoneOff, Monitor, MonitorOff, Video, VideoOff, Signal, ChevronRight } from 'lucide-react'
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

function qualityLabel(quality: ConnectionQuality | null | undefined) {
  return quality ? `Connection: ${quality}` : 'Measuring connection…'
}

interface PeerRowProps {
  initial: string
  name: string
  speaking: boolean
  muted: boolean
  quality: ConnectionQuality | null | undefined
  self?: boolean
  /** When provided, the row is expandable to reveal a volume slider. */
  volume?: number
  onVolumeChange?: (value: number) => void
}

function PeerRow({ initial, name, speaking, muted, quality, self, volume, onVolumeChange }: PeerRowProps) {
  const [expanded, setExpanded] = useState(false)
  const interactive = !self && volume !== undefined && !!onVolumeChange

  const avatarClass =
    'voice-row__avatar'
    + (speaking ? ' voice-row__avatar--speaking' : '')
    + (muted ? ' voice-row__avatar--muted' : '')
    + (self ? ' voice-row__avatar--self' : '')

  return (
    <div className={`voice-row${expanded ? ' voice-row--expanded' : ''}`}>
      <div
        className={`voice-row__main${interactive ? ' voice-row__main--interactive' : ''}`}
        onClick={interactive ? () => setExpanded((v) => !v) : undefined}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        title={interactive ? `${name} — click to adjust volume` : name}
      >
        <div className="voice-row__avatar-wrap">
          <div className={avatarClass}>
            <span>{initial}</span>
          </div>
          {speaking && <span className="voice-row__speaking-pip" />}
        </div>

        <span className={`voice-row__name${speaking ? ' voice-row__name--speaking' : ''}`}>
          {name}
          {self && <span className="voice-row__you-tag">you</span>}
        </span>

        <span className="voice-row__status">
          {muted ? (
            <MicOff className="voice-row__status-icon voice-row__status-icon--muted" />
          ) : (
            <span
              className={`voice-row__quality-dot voice-row__quality-dot--${quality ?? 'unknown'}`}
              title={qualityLabel(quality)}
            />
          )}
          {interactive && (
            <ChevronRight className={`voice-row__chevron${expanded ? ' voice-row__chevron--open' : ''}`} />
          )}
        </span>
      </div>

      {interactive && expanded && (
        <div className="voice-row__volume" onClick={(e) => e.stopPropagation()}>
          <Slider
            size="sm"
            min={0}
            max={200}
            value={volume!}
            onChange={(value) => onVolumeChange!(value)}
            ariaLabel={`Volume for ${name}`}
          />
          <span className="voice-row__volume-value">{volume}%</span>
        </div>
      )}
    </div>
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
        }, 220)
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
    }, 220)
  }, [leaveVoice, setVoiceError])

  // Publish the panel's height so the mobile chat column can reserve space for
  // it (it's a fixed bottom sheet there) and not hide the composer.
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
  const peerCount = voicePeers.length + 1

  const handleRetry = () => {
    setVoiceError(null)
  }

  return (
    <div ref={overlayRef} className={`voice-overlay${closing ? ' voice-overlay--closing' : ''}${voiceError ? ' voice-overlay--error' : ''}`}>
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

      {!voiceError && (
        <>
          <div className="voice-header">
            <Signal className="voice-header__signal" />
            <div className="voice-header__title">
              <span className="voice-header__status">{isDMCall ? 'In Call' : 'Voice Connected'}</span>
              <span className="voice-header__channel" title={headerName ?? undefined}>
                {headerName}
              </span>
            </div>
            <span className="voice-header__count" title={`${peerCount} in call`}>{peerCount}</span>
          </div>

          <div className="voice-peers">
            <PeerRow
              initial={isDMCall ? 'Y' : (channel?.name?.[0]?.toUpperCase() ?? 'Y')}
              name="You"
              speaking={isSpeaking && !isMuted}
              muted={isMuted}
              quality={localConnectionQuality}
              self
            />
            {voicePeers.map((peer) => (
              <PeerRow
                key={peer.id}
                initial={peer.username?.[0]?.toUpperCase() ?? '?'}
                name={peer.username}
                speaking={peer.speaking && !peer.muted}
                muted={peer.muted}
                quality={peer.connectionQuality}
                volume={peerVolumes[peer.id] ?? 100}
                onVolumeChange={(value) => setPeerVolume(peer.id, value)}
              />
            ))}
          </div>

          {screenShareError && (
            <div className="voice-inline-error">
              <span>{screenShareError}</span>
              <button onClick={() => setScreenShareError(null)} className="voice-inline-error__dismiss">
                dismiss
              </button>
            </div>
          )}

          <div className="voice-controls">
            <button
              onClick={toggleMute}
              className={`voice-ctrl ${isMuted ? 'voice-ctrl--danger-active' : ''}`}
              title={isMuted ? 'Unmute' : 'Mute'}
              aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? <MicOff className="icon-xs" /> : <Mic className="icon-xs" />}
            </button>

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
                className={`voice-ctrl ${isScreenSharing ? 'voice-ctrl--brand-active' : ''}`}
                title={isScreenSharing ? 'Stop sharing' : screenSharePeerId ? 'Someone else is sharing' : 'Share screen'}
                disabled={!!screenSharePeerId && !isScreenSharing}
              >
                {isScreenSharing ? <MonitorOff className="icon-xs" /> : <Monitor className="icon-xs" />}
              </button>
            )}

            {toggleCamera && (
              <button
                onClick={() => toggleCamera(activeVoiceChannelId!)}
                className={`voice-ctrl ${isCameraOn ? 'voice-ctrl--brand-active' : ''}`}
                title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
                aria-label={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
              >
                {isCameraOn ? <Video className="icon-xs" /> : <VideoOff className="icon-xs" />}
              </button>
            )}

            <button
              onClick={handleLeave}
              className="voice-ctrl voice-ctrl--leave"
              title="Leave call"
              aria-label="Leave call"
            >
              <PhoneOff className="icon-xs" />
            </button>
          </div>
        </>
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
    </div>
  )
}
