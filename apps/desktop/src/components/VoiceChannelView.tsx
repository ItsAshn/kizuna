import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { useServerStore } from '../store/serverStore'
import { Mic, MicOff, PhoneOff, Monitor, MonitorOff, Video, VideoOff, Volume2 } from 'lucide-react'
import MonitorPicker from './MonitorPicker'
import { useMobile } from '../hooks/useMobile'
import './VoiceChannelView.css'

interface VoiceChannelViewProps {
  channelId: string
  joinVoice: (channelId: string) => void
  leaveVoice: () => void
  toggleMute: () => void
  toggleCamera: (channelId: string) => void
  startScreenshare: (channelId: string, monitorIndex: number, fps: number) => Promise<string | null>
  stopScreenshare: () => void
  isCameraOn: boolean
  cameraStreamRef: React.MutableRefObject<MediaStream | null>
  videoElRef: React.MutableRefObject<HTMLVideoElement | null>
}

/** Attaches a live MediaStream to a muted, autoplaying <video>. */
function TileVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.srcObject = stream
    return () => {
      if (el) el.srcObject = null
    }
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted className="vcv-tile__video" />
}

interface TileProps {
  name: string
  speaking?: boolean
  muted?: boolean
  stream?: MediaStream | null
}

function Tile({ name, speaking, muted, stream }: TileProps) {
  return (
    <div className={`vcv-tile${speaking && !muted ? ' vcv-tile--speaking' : ''}`}>
      {stream ? (
        <TileVideo stream={stream} />
      ) : (
        <div className="vcv-tile__avatar">
          <span>{name?.[0]?.toUpperCase() || '?'}</span>
        </div>
      )}
      <div className="vcv-tile__footer">
        {muted && <MicOff className="icon-xs vcv-tile__muted-icon" />}
        <span className="vcv-tile__name">{name}</span>
      </div>
    </div>
  )
}

export default function VoiceChannelView({
  channelId,
  joinVoice,
  leaveVoice,
  toggleMute,
  toggleCamera,
  startScreenshare,
  stopScreenshare,
  isCameraOn,
  cameraStreamRef,
  videoElRef,
}: VoiceChannelViewProps) {
  const channels = useChatStore((s) => s.channels)
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId)
  const voicePeers = useVoiceStore((s) => s.voicePeers)
  const isMuted = useVoiceStore((s) => s.isMuted)
  const isSpeaking = useVoiceStore((s) => s.isSpeaking)
  const peerCameraStreams = useVoiceStore((s) => s.peerCameraStreams)
  const voiceChannelUsers = useVoiceStore((s) => s.voiceChannelUsers)
  const isScreenSharing = useCallStore((s) => s.isScreenSharing)
  const screenSharePeerId = useCallStore((s) => s.screenSharePeerId)
  const screenShareUsername = useCallStore((s) => s.screenShareUsername)
  const session = useServerStore((s) => s.activeSession)
  const isMobile = useMobile()

  const [showMonitorPicker, setShowMonitorPicker] = useState(false)
  const [screenShareError, setScreenShareError] = useState<string | null>(null)

  const channel = channels.find((c) => c.id === channelId)
  const channelName = channel?.name || 'Voice Channel'
  const isConnectedHere = activeVoiceChannelId === channelId
  const isScreenActive = !!(screenSharePeerId || isScreenSharing)
  const canScreenShare = !isMobile && '__TAURI_INTERNALS__' in window

  // Adopt the single shared screenshare <video> element into this stage while
  // it is the active view for the connected call. ScreenShareOverlay yields the
  // element (it is gated off in Chat.tsx) so it is never double-mounted.
  const screenContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = screenContainerRef.current
    if (!container || !videoElRef.current) return
    container.innerHTML = ''
    container.appendChild(videoElRef.current)
  }, [isConnectedHere, isScreenActive, screenSharePeerId, videoElRef])

  // Not connected to this channel: show who's inside + a join affordance.
  if (!isConnectedHere) {
    const occupants = voiceChannelUsers[channelId] || []
    return (
      <div className="vcv">
        <div className="vcv__header">
          <Volume2 className="icon-xs" />
          <span className="vcv__title">{channelName}</span>
        </div>
        <div className="vcv__grid">
          {occupants.length === 0 ? (
            <div className="vcv__empty">No one is in this channel yet.</div>
          ) : (
            occupants.map((u) => <Tile key={u.userId} name={u.username} />)
          )}
        </div>
        <div className="vcv__controls">
          <button className="vcv__join-btn" onClick={() => joinVoice(channelId)}>
            Join Voice
          </button>
        </div>
      </div>
    )
  }

  const sharerName = isScreenSharing ? 'You' : screenShareUsername || 'Someone'

  return (
    <div className="vcv">
      <div className="vcv__header">
        <Volume2 className="icon-xs" />
        <span className="vcv__title">{channelName}</span>
        <span className="vcv__status">connected</span>
      </div>

      {screenShareError && (
        <div className="vcv__error">
          <span>{screenShareError}</span>
          <button onClick={() => setScreenShareError(null)}>dismiss</button>
        </div>
      )}

      {isScreenActive && (
        <div className="vcv__screenshare">
          <div className="vcv__screenshare-body" ref={screenContainerRef}>
            {!videoElRef.current && <div className="vcv__screenshare-empty">Waiting for video…</div>}
          </div>
          <span className="vcv__screenshare-label">{sharerName}'s screen</span>
        </div>
      )}

      <div className="vcv__grid">
        <Tile
          name={session?.user.username || 'You'}
          speaking={isSpeaking}
          muted={isMuted}
          stream={isCameraOn ? cameraStreamRef.current : null}
        />
        {voicePeers.map((peer) => (
          <Tile
            key={peer.id}
            name={peer.username}
            speaking={peer.speaking}
            muted={peer.muted}
            stream={peerCameraStreams[peer.id] || null}
          />
        ))}
      </div>

      <div className="vcv__controls">
        <button
          onClick={toggleMute}
          className={`vcv__ctrl ${isMuted ? 'vcv__ctrl--danger' : ''}`}
          title={isMuted ? 'Unmute' : 'Mute'}
          aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {isMuted ? <MicOff className="icon-sm" /> : <Mic className="icon-sm" />}
        </button>
        <button
          onClick={() => toggleCamera(channelId)}
          className={`vcv__ctrl ${isCameraOn ? 'vcv__ctrl--active' : ''}`}
          title={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
          aria-label={isCameraOn ? 'Turn off camera' : 'Turn on camera'}
        >
          {isCameraOn ? <Video className="icon-sm" /> : <VideoOff className="icon-sm" />}
        </button>
        {canScreenShare && (
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
            className={`vcv__ctrl ${isScreenSharing ? 'vcv__ctrl--active' : ''}`}
            title={isScreenSharing ? 'Stop sharing' : screenSharePeerId ? 'Someone else is sharing' : 'Share screen'}
            disabled={!!screenSharePeerId && !isScreenSharing}
          >
            {isScreenSharing ? <MonitorOff className="icon-sm" /> : <Monitor className="icon-sm" />}
          </button>
        )}
        <button
          onClick={leaveVoice}
          className="vcv__ctrl vcv__ctrl--leave"
          title="Leave"
          aria-label="Leave voice channel"
        >
          <PhoneOff className="icon-sm" />
        </button>
      </div>

      {showMonitorPicker && (
        <MonitorPicker
          onSelect={async (monitorIndex) => {
            setShowMonitorPicker(false)
            const err = await startScreenshare(channelId, monitorIndex, 15)
            if (err) setScreenShareError(err)
          }}
          onCancel={() => setShowMonitorPicker(false)}
        />
      )}
    </div>
  )
}
