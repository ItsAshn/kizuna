import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore, type PeerVideo } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { useServerStore } from '../store/serverStore'
import { Mic, MicOff, PhoneOff, Monitor, MonitorOff, Video, VideoOff, Volume2 } from 'lucide-react'
import MonitorPicker from './MonitorPicker'
import NativeVideoCanvas from './NativeVideoCanvas'
import { useMobile } from '../hooks/useMobile'
import { isTauri, isMobileTauri, MOBILE_SCREENSHARE_UNSUPPORTED } from '../utils/platform'
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
  videoElRef: React.MutableRefObject<HTMLVideoElement | HTMLCanvasElement | null>
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
  video?: PeerVideo | null
}

function Tile({ name, speaking, muted, video }: TileProps) {
  return (
    <div className={`vcv-tile${speaking && !muted ? ' vcv-tile--speaking' : ''}`}>
      {video?.kind === 'stream' ? (
        <TileVideo stream={video.stream} />
      ) : video?.kind === 'native' ? (
        <NativeVideoCanvas streamId={video.streamId} className="vcv-tile__video" />
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
  const peerCameraVideos = useVoiceStore((s) => s.peerCameraVideos)
  const voiceChannelUsers = useVoiceStore((s) => s.voiceChannelUsers)
  const voiceConnectingChannelId = useVoiceStore((s) => s.voiceConnectingChannelId)
  const voiceReconnecting = useVoiceStore((s) => s.voiceReconnecting)
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
  const connectingHere = voiceConnectingChannelId === channelId
  const isScreenActive = !!(screenSharePeerId || isScreenSharing)
  // Shown on Android at any width so it can say why it does nothing there,
  // rather than vanishing or failing with a missing-command error.
  const screenShareUnsupported = isMobileTauri()
  const canScreenShare = screenShareUnsupported || (!isMobile && isTauri())
  const someoneElseSharing = !!screenSharePeerId && !isScreenSharing

  // Adopt the single shared screenshare <video> element into this stage while
  // it is the active view for the connected call. ScreenShareOverlay yields the
  // element (it is gated off in Chat.tsx) so it is never double-mounted.
  const screenContainerRef = useRef<HTMLDivElement>(null)
  const [videoAttached, setVideoAttached] = useState(false)
  useEffect(() => {
    const container = screenContainerRef.current
    const el = videoElRef.current
    if (!container || !el) {
      setVideoAttached(false)
      return
    }
    container.replaceChildren(el)
    setVideoAttached(true)
    return () => {
      container.replaceChildren()
      setVideoAttached(false)
    }
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
          <button
            className="vcv__join-btn"
            onClick={() => joinVoice(channelId)}
            disabled={connectingHere}
          >
            {connectingHere ? 'Connecting…' : 'Join Voice'}
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
        <span className="vcv__status">
          {voiceReconnecting ? 'reconnecting…' : connectingHere ? 'connecting…' : 'connected'}
        </span>
      </div>

      {screenShareError && (
        <div className="vcv__error">
          <span>{screenShareError}</span>
          <button onClick={() => setScreenShareError(null)}>dismiss</button>
        </div>
      )}

      {isScreenActive && (
        <div className="vcv__screenshare">
          <div className="vcv__screenshare-body">
            {/* Kept empty by React — the shared <video> is adopted into it. */}
            <div className="vcv__screenshare-video" ref={screenContainerRef} />
            {!videoAttached && <div className="vcv__screenshare-empty">Waiting for video…</div>}
          </div>
          <span className="vcv__screenshare-label">{sharerName}'s screen</span>
        </div>
      )}

      <div className="vcv__grid">
        <Tile
          name={session?.user.username || 'You'}
          speaking={isSpeaking}
          muted={isMuted}
          video={
            isCameraOn && cameraStreamRef.current
              ? { kind: 'stream', stream: cameraStreamRef.current }
              : null
          }
        />
        {voicePeers.map((peer) => (
          <Tile
            key={peer.id}
            name={peer.username}
            speaking={peer.speaking}
            muted={peer.muted}
            video={peerCameraVideos[peer.id] || null}
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
              if (screenShareUnsupported) {
                setScreenShareError(MOBILE_SCREENSHARE_UNSUPPORTED)
              } else if (isScreenSharing) {
                stopScreenshare()
                setScreenShareError(null)
              } else if (someoneElseSharing) {
                setScreenShareError(
                  `${screenShareUsername || 'Someone else'} is sharing — only one screen at a time`,
                )
              } else {
                setShowMonitorPicker(true)
              }
            }}
            className={`vcv__ctrl ${isScreenSharing ? 'vcv__ctrl--active' : ''}`}
            title={
              screenShareUnsupported
                ? 'Screen sharing is not available on mobile'
                : isScreenSharing
                  ? 'Stop sharing'
                  : someoneElseSharing
                    ? `${screenShareUsername || 'Someone else'} is sharing`
                    : 'Share screen'
            }
            /* Left clickable on purpose — the click is what explains why it
               won't start. */
            aria-disabled={someoneElseSharing || screenShareUnsupported}
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
          onSelect={async (monitorIndex, fps) => {
            setShowMonitorPicker(false)
            const err = await startScreenshare(channelId, monitorIndex, fps)
            if (err) setScreenShareError(err)
          }}
          onCancel={() => setShowMonitorPicker(false)}
        />
      )}
    </div>
  )
}
