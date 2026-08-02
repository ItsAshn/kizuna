import { useRef, useCallback, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { Device } from 'mediasoup-client'
import type { Transport, Producer, Consumer, RtpCapabilities } from 'mediasoup-client/types'
import { useServerStore } from '../store/serverStore'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { useSettingsStore } from '../store/settingsStore'
import type { ConnectionQuality } from '@kizuna/shared'
import { isTauri, isMobileTauri } from '../utils/platform'

interface VoiceJoinResult {
  error?: string
  routerRtpCapabilities?: RtpCapabilities
  iceServers?: { urls: string; username?: string; credential?: string }[]
  peers?: {
    id: string
    userId: string
    username: string
    hasCamera?: boolean
    muted?: boolean
  }[]
  voiceBitrateKbps?: number
  screenSharePeer?: { peerId: string; username: string }
}

interface ConsumeResult {
  id?: string
  error?: string
  rtpParameters?: { encodings?: { ssrc?: number }[] }
  [key: string]: unknown
}

interface TransportResult {
  id?: string
  error?: string
  [key: string]: unknown
}

/**
 * Handle to the video track the Rust send transport already carries, used by
 * the native screenshare path on Linux (see useScreenshare).
 */
export interface NativeVideoProducer {
  transportId: string
  rtpParameters: Record<string, unknown>
  producerId: string | null
}

interface RTCStatEntry {
  type: string
  state?: string
  currentRoundTripTime?: number
  kind?: string
  jitter?: number
  packetsReceived?: number
  packetsLost?: number
  roundTripTime?: number
  fractionLost?: number
  [key: string]: unknown
}

interface VoiceEventPayload {
  type: string
  data: {
    peer_id?: string
    user_id?: string
    username?: string
    state?: string
    error?: string
    speaking?: boolean
  }
}

interface VoiceSpeakingPayload {
  channelId: string
  speaking: boolean
  level?: number
}

const SPEAKING_RMS_THRESHOLD = 8
const SPEAKING_POLL_MS = 80
const SPEAKING_HOLD_MS = 600
const REMOTE_SPEAKING_THRESHOLD = 15
const QUALITY_POLL_MS = 3000
const RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_ATTEMPTS = 5
const AUDIO_SAMPLE_RATE = 48000

// Map the 0..100 gate slider to dBFS. Shared by the native (Rust) and browser
// (worklet) noise gates so the same slider position gates identically on
// every platform.
const gateSliderToDb = (threshold: number) => -(threshold * 0.5) - 25 // 0..100 -> -25..-75 dB

let __voiceSeq = 0
const MAX_VOICE_LOG_LINES = 30
const __voiceLogBuffer: string[] = []
function voiceLog(level: 'log' | 'err', tag: string, msg: string, extra?: string) {
  const seq = ++__voiceSeq
  const ts = new Date().toISOString().split('T')[1].slice(0, 12)
  const line = `[${ts}] ${tag}: ${msg}${extra ?? ''}`
  __voiceLogBuffer.push(line)
  if (__voiceLogBuffer.length > MAX_VOICE_LOG_LINES) __voiceLogBuffer.shift()
  if (level === 'err') console.error(`[VOICE ${seq}] ${line}`)
  else console.log(`[VOICE ${seq}] ${line}`)
}
export function getVoiceLogLines(): string[] {
  return [...__voiceLogBuffer]
}
function vlog(tag: string, msg: string, data?: unknown) {
  const extra = data !== undefined ? ` ${JSON.stringify(data).slice(0, 200)}` : ''
  voiceLog('log', tag, msg, extra)
}
function verr(tag: string, msg: string, err?: unknown) {
  const detail = err instanceof Error ? `${err.message} (${err.name})` : String(err ?? '')
  voiceLog('err', tag, msg, ` | ${detail}`)
}

const setLiveAudioLevel = (level: number) => useVoiceStore.getState().setLiveAudioLevel(level)

/**
 * Whether a key event is landing in something the user is typing into. The
 * push-to-talk key is only swallowed when it isn't — otherwise binding a
 * letter to PTT would stop that letter reaching the composer.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

function computeQualityFromStats(report: RTCStatsReport): ConnectionQuality {
  let rttMs = 0
  let jitterMs = 0
  let lossRate = 0
  report.forEach((stat: RTCStatEntry) => {
    if (
      stat.type === 'candidate-pair' &&
      stat.state === 'succeeded' &&
      stat.currentRoundTripTime != null
    ) {
      rttMs = stat.currentRoundTripTime * 1000
    }
    if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
      jitterMs = (stat.jitter ?? 0) * 1000
      const received = stat.packetsReceived ?? 0
      const lost = stat.packetsLost ?? 0
      const total = received + lost
      lossRate = total > 0 ? (lost / total) * 100 : 0
    }
    if (stat.type === 'remote-inbound-rtp' && stat.kind === 'audio') {
      if (stat.roundTripTime != null) rttMs = stat.roundTripTime * 1000
      const lostFrac = stat.fractionLost ?? 0
      lossRate = Math.max(lossRate, lostFrac * 100)
    }
  })
  if (rttMs > 300 || jitterMs > 50 || lossRate > 8) return 'poor'
  if (rttMs > 150 || jitterMs > 25 || lossRate > 3) return 'fair'
  return 'good'
}

function startSpeakingDetection(
  stream: MediaStream,
  onSpeaking: (speaking: boolean) => void,
  onLevel?: (level: number) => void,
  gainNode?: GainNode,
  audioCtx?: AudioContext,
): () => void {
  const ctx = audioCtx ?? new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.1
  // When the producing graph's gain node is provided, tap it directly for
  // metering. Feeding a second mic source into that node would sum a raw,
  // ungated copy of the mic into the track peers hear.
  let analyserStream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  if (gainNode) {
    gainNode.connect(analyser)
  } else {
    analyserStream = stream.clone()
    source = ctx.createMediaStreamSource(analyserStream)
    source.connect(analyser)
  }
  const buf = new Uint8Array(analyser.fftSize)
  let speaking = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  const poll = () => {
    if (stopped) return
    if (ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          timer = setTimeout(poll, SPEAKING_POLL_MS)
        })
        .catch((err) => {
          console.error('Failed to resume AudioContext (local speaking):', err)
          timer = setTimeout(poll, 200)
        })
      return
    }
    analyser.getByteTimeDomainData(buf)
    let squareSum = 0
    for (let i = 0; i < buf.length; i++) {
      const deviation = buf[i] - 128
      squareSum += deviation * deviation
    }
    const rms = Math.sqrt(squareSum / buf.length)
    onLevel?.(rms)
    const nowSpeaking = rms > SPEAKING_RMS_THRESHOLD
    if (nowSpeaking) {
      if (holdTimer !== null) {
        clearTimeout(holdTimer)
        holdTimer = null
      }
      if (!speaking) {
        speaking = true
        onSpeaking(true)
      }
    } else if (speaking && holdTimer === null) {
      holdTimer = setTimeout(() => {
        holdTimer = null
        speaking = false
        onSpeaking(false)
      }, SPEAKING_HOLD_MS)
    }
    timer = setTimeout(poll, SPEAKING_POLL_MS)
  }

  ctx.resume().then(poll).catch(poll)

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    if (holdTimer !== null) clearTimeout(holdTimer)
    if (gainNode) gainNode.disconnect(analyser)
    source?.disconnect()
    if (!audioCtx) ctx.close()
    analyserStream?.getTracks().forEach((t) => t.stop())
  }
}

function startRemoteSpeakingDetection(
  track: MediaStreamTrack,
  onSpeaking: (speaking: boolean) => void,
  sharedCtx?: AudioContext,
): () => void {
  const ownsCtx = !sharedCtx
  const ctx = sharedCtx ?? new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
  const stream = new MediaStream([track])
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.3
  source.connect(analyser)
  const buf = new Uint8Array(analyser.frequencyBinCount)
  let speaking = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  const poll = () => {
    if (stopped) return
    if (ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          timer = setTimeout(poll, SPEAKING_POLL_MS)
        })
        .catch((err) => {
          console.error('Failed to resume AudioContext (remote speaking):', err)
          timer = setTimeout(poll, 200)
        })
      return
    }
    analyser.getByteFrequencyData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i]
    const rms = sum / buf.length
    const nowSpeaking = rms > REMOTE_SPEAKING_THRESHOLD
    if (nowSpeaking) {
      if (holdTimer !== null) {
        clearTimeout(holdTimer)
        holdTimer = null
      }
      if (!speaking) {
        speaking = true
        onSpeaking(true)
      }
    } else if (speaking && holdTimer === null) {
      holdTimer = setTimeout(() => {
        holdTimer = null
        speaking = false
        onSpeaking(false)
      }, SPEAKING_HOLD_MS)
    }
    timer = setTimeout(poll, SPEAKING_POLL_MS)
  }

  ctx.resume().then(poll).catch(poll)

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    if (holdTimer !== null) clearTimeout(holdTimer)
    source.disconnect()
    if (ownsCtx) ctx.close()
  }
}

export function useVoice(socketRef: React.MutableRefObject<Socket | null>) {
  const session = useServerStore((s) => s.activeSession)

  const deviceRef = useRef<Device | null>(null)
  const sendTransportRef = useRef<Transport | null>(null)
  const recvTransportRef = useRef<Transport | null>(null)
  const producerRef = useRef<Producer | null>(null)
  const consumersRef = useRef<Map<string, Consumer>>(new Map())
  const audioElemsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  // Per-peer playback gain on the browser path. HTMLMediaElement.volume is
  // capped at 1.0 by spec, so the master and per-peer sliders (which go to
  // 200%) can only be honoured through WebAudio.
  const peerGainNodesRef = useRef<Map<string, GainNode>>(new Map())
  const videoConsumerRef = useRef<Consumer | null>(null)
  // Everything the native screenshare path needs to produce video on the Rust
  // send transport. Populated by joinVoiceNative; the producer is created lazily
  // on first share and reused for the rest of the call.
  const nativeVideoRef = useRef<NativeVideoProducer | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const cameraConsumersRef = useRef<Map<string, Consumer>>(new Map())
  const channelIdRef = useRef<string | null>(null)
  const localSpeakingCleanupRef = useRef<(() => void) | null>(null)
  const remoteSpeakingCleanupsRef = useRef<Map<string, () => void>>(new Map())
  const qualityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const peerQualityIntervalsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const reconnectAttemptsRef = useRef(0)
  const isReconnectingRef = useRef(false)
  const rejoiningRef = useRef(false)
  const socketWasConnectedRef = useRef(true)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const remoteAudioCtxRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const pttCleanupRef = useRef<(() => void) | null>(null)
  const pttPressedRef = useRef<boolean>(false)
  const serverBitrateRef = useRef<number>(64)
  const iceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setActiveVoiceChannel = useVoiceStore((s) => s.setActiveVoiceChannel)
  const setVoiceConnectingChannelId = useVoiceStore((s) => s.setVoiceConnectingChannelId)
  const setVoiceReconnecting = useVoiceStore((s) => s.setVoiceReconnecting)
  const setVoicePeers = useVoiceStore((s) => s.setVoicePeers)
  const addVoicePeer = useVoiceStore((s) => s.addVoicePeer)
  const removeVoicePeer = useVoiceStore((s) => s.removeVoicePeer)
  const updateVoicePeer = useVoiceStore((s) => s.updateVoicePeer)
  const setPeerCameraStream = useVoiceStore((s) => s.setPeerCameraStream)
  const removePeerCameraStream = useVoiceStore((s) => s.removePeerCameraStream)
  const clearPeerCameraStreams = useVoiceStore((s) => s.clearPeerCameraStreams)
  const setIsMuted = useVoiceStore((s) => s.setIsMuted)
  const setIsSpeaking = useVoiceStore((s) => s.setIsSpeaking)
  const setLocalConnectionQuality = useVoiceStore((s) => s.setLocalConnectionQuality)
  const serverVoiceBitrateKbps = useVoiceStore((s) => s.serverVoiceBitrateKbps)
  const setServerVoiceBitrateKbps = useVoiceStore((s) => s.setServerVoiceBitrateKbps)
  const audioInputDeviceId = useVoiceStore((s) => s.audioInputDeviceId)
  const audioOutputDeviceId = useVoiceStore((s) => s.audioOutputDeviceId)
  const setAudioInputDeviceId = useVoiceStore((s) => s.setAudioInputDeviceId)
  const setVoiceError = useVoiceStore((s) => s.setVoiceError)
  const voiceInputMode = useVoiceStore((s) => s.voiceInputMode)
  const pushToTalkKey = useVoiceStore((s) => s.pushToTalkKey)
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression)
  const autoGainControl = useVoiceStore((s) => s.autoGainControl)
  const echoCancellation = useVoiceStore((s) => s.echoCancellation)
  const noiseGateEnabled = useVoiceStore((s) => s.noiseGateEnabled)
  const noiseGateThreshold = useVoiceStore((s) => s.noiseGateThreshold)
  const noiseSuppressionStrength = useVoiceStore((s) => s.noiseSuppressionStrength)
  const inputVolume = useVoiceStore((s) => s.inputVolume)
  const outputVolume = useVoiceStore((s) => s.outputVolume)
  const setScreenSharePeer = useCallStore((s) => s.setScreenSharePeer)
  const clearScreenSharePeer = useCallStore((s) => s.clearScreenSharePeer)
  const setDMCallStatus = useCallStore((s) => s.setDMCallStatus)
  const setDMCallChannelId = useCallStore((s) => s.setDMCallChannelId)
  const setDMCallOtherUser = useCallStore((s) => s.setDMCallOtherUser)
  const setIncomingCall = useCallStore((s) => s.setIncomingCall)
  const clearDMCall = useCallStore((s) => s.clearDMCall)
  const dmCallChannelId = useCallStore((s) => s.dmCallChannelId)

  const cleanupVoice = useCallback(() => {
    vlog('cleanup', 'starting')
    pttCleanupRef.current?.()
    pttCleanupRef.current = null
    pttPressedRef.current = false
    if (qualityIntervalRef.current != null) {
      clearInterval(qualityIntervalRef.current)
      qualityIntervalRef.current = null
    }
    peerQualityIntervalsRef.current.forEach((interval) => clearInterval(interval))
    peerQualityIntervalsRef.current.clear()

    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = null
    remoteSpeakingCleanupsRef.current.forEach((cleanup) => cleanup())
    remoteSpeakingCleanupsRef.current.clear()

    nativeVoiceUnlistenRef.current?.()
    nativeVoiceUnlistenRef.current = null

    if (iceTimerRef.current) {
      clearTimeout(iceTimerRef.current)
      iceTimerRef.current = null
    }

    producerRef.current?.close()
    producerRef.current = null
    consumersRef.current.forEach((c) => c.close())
    consumersRef.current.clear()
    videoConsumerRef.current?.close()
    videoConsumerRef.current = null
    cameraConsumersRef.current.forEach((c) => c.close())
    cameraConsumersRef.current.clear()
    clearPeerCameraStreams()
    if (videoElRef.current) {
      videoElRef.current.pause()
      videoElRef.current.srcObject = null
      videoElRef.current = null
    }
    audioElemsRef.current.forEach((el) => {
      el.pause()
      el.srcObject = null
    })
    audioElemsRef.current.clear()
    peerGainNodesRef.current.forEach((node) => node.disconnect())
    peerGainNodesRef.current.clear()
    sendTransportRef.current?.close()
    recvTransportRef.current?.close()
    sendTransportRef.current = null
    recvTransportRef.current = null
    nativeVideoRef.current = null
    // A screenshare cannot outlive its call — the capture session is torn down
    // with the call, so the button must not stay lit.
    useCallStore.getState().setIsScreenSharing(false)
    deviceRef.current = null
    gainNodeRef.current = null
    workletNodeRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    remoteAudioCtxRef.current?.close()
    remoteAudioCtxRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    setVoicePeers([])
    setIsSpeaking(false)
    setLocalConnectionQuality(null)
    setLiveAudioLevel(0)
    clearScreenSharePeer()
    useVoiceStore.getState().setIceServers([])
  }, [
    setVoicePeers,
    setIsSpeaking,
    setLocalConnectionQuality,
    clearScreenSharePeer,
    clearPeerCameraStreams,
  ])

  /**
   * Push the master output volume and every per-peer volume out to whichever
   * backend is playing audio. Both sliders range 0-200%, so the browser path
   * uses GainNodes and only falls back to element volume (hard-capped at 100%)
   * when WebAudio routing wasn't available for that peer.
   */
  const applyOutputVolumes = useCallback(() => {
    const { outputVolume: master, peerVolumes } = useVoiceStore.getState()
    const masterGain = Math.max(0, master / 100)
    const peerGain = (peerId: string) => Math.max(0, (peerVolumes[peerId] ?? 100) / 100)

    peerGainNodesRef.current.forEach((node, peerId) => {
      node.gain.value = masterGain * peerGain(peerId)
    })
    audioElemsRef.current.forEach((el, peerId) => {
      if (peerGainNodesRef.current.has(peerId)) return
      el.volume = Math.min(1, masterGain * peerGain(peerId))
    })

    if (isTauri() && !isMobileTauri()) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('voice_set_output_volume', { volume: masterGain }).catch((err) =>
          verr('volume', 'voice_set_output_volume failed', err),
        )
        for (const peer of useVoiceStore.getState().voicePeers) {
          invoke('voice_set_peer_volume', {
            peerId: peer.id,
            volume: peerGain(peer.id),
          }).catch((err) => verr('volume', 'voice_set_peer_volume failed', err))
        }
      })
    }
  }, [])

  const consumePeer = useCallback(
    async (
      socket: Socket,
      device: Device,
      recvTransport: Transport,
      peerId: string,
      channelId: string,
      remoteCtx: AudioContext,
    ) => {
      vlog('consume', `consuming peer peerId=${peerId}`)
      const params: Record<string, unknown> = await new Promise((resolve) =>
        socket.emit(
          'voice:consume',
          { channelId, peerId, rtpCapabilities: device.rtpCapabilities },
          resolve,
        ),
      )
      if (!params?.id) {
        verr('consume', `no id returned for peer ${peerId}`, params)
        return
      }
      const consumer = await recvTransport.consume(
        params as Parameters<typeof recvTransport.consume>[0],
      )
      consumersRef.current.set(peerId, consumer)
      vlog(
        'consume',
        `consumer created | id=${consumer.id} | kind=${consumer.kind} | paused=${consumer.paused}`,
      )

      await new Promise<void>((resolve) =>
        socket.emit('voice:resumeConsumer', { channelId, consumerId: consumer.id }, () =>
          resolve(),
        ),
      )
      await consumer.resume()
      vlog('consume', `consumer resumed | id=${consumer.id}`)

      const audioEl = new Audio()
      audioEl.autoplay = true
      // Route through a per-peer GainNode, then back out to a MediaStream, so
      // the element still owns output-device routing (setSinkId) while volume
      // above 100% remains possible. If WebAudio can't take the remote track,
      // fall back to playing it directly at element volume.
      let routed = false
      try {
        const source = remoteCtx.createMediaStreamSource(new MediaStream([consumer.track]))
        const peerGain = remoteCtx.createGain()
        const dest = remoteCtx.createMediaStreamDestination()
        source.connect(peerGain)
        peerGain.connect(dest)
        peerGainNodesRef.current.set(peerId, peerGain)
        audioEl.srcObject = dest.stream
        audioEl.volume = 1
        routed = true
      } catch (e) {
        vlog('consume', `WebAudio routing unavailable, using element volume: ${String(e)}`)
      }
      if (!routed) {
        audioEl.srcObject = new MediaStream([consumer.track])
      }
      audioElemsRef.current.set(peerId, audioEl)
      applyOutputVolumes()
      vlog('consume', `audio element created | routed=${routed} | volume=${audioEl.volume}`)
      if (audioOutputDeviceId) {
        try {
          await (audioEl as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(
            audioOutputDeviceId,
          )
          vlog('consume', `sinkId set to ${audioOutputDeviceId}`)
        } catch (e) {
          vlog('consume', `setSinkId failed or unsupported: ${String(e)}`)
        }
      }
      const playResult = await audioEl
        .play()
        .then(() => 'ok')
        .catch((e) => `error: ${e?.name ?? String(e)}`)
      vlog('consume', `audio.play() -> ${playResult}`)

      const cleanupRemote = startRemoteSpeakingDetection(
        consumer.track,
        (speaking) => updateVoicePeer(peerId, { speaking }),
        remoteCtx,
      )
      remoteSpeakingCleanupsRef.current.set(peerId, cleanupRemote)

      const pollPeerQuality = async () => {
        const c = consumersRef.current.get(peerId)
        if (!c) return
        try {
          const stats = await c.getStats()
          updateVoicePeer(peerId, {
            connectionQuality: computeQualityFromStats(stats),
          })
        } catch (err) {
          console.error('Failed to get peer RTC stats:', err)
        }
      }
      pollPeerQuality()
      const peerQInt = setInterval(pollPeerQuality, QUALITY_POLL_MS)
      peerQualityIntervalsRef.current.set(peerId, peerQInt)
    },
    [audioOutputDeviceId, updateVoicePeer, applyOutputVolumes],
  )

  const consumeScreenShare = useCallback(
    async (
      socket: Socket,
      device: Device,
      recvTransport: Transport,
      sharerPeerId: string,
      channelId: string,
      username: string,
    ) => {
      try {
        const params: Record<string, unknown> = await new Promise((resolve) =>
          socket.emit(
            'voice:consume',
            {
              channelId,
              peerId: sharerPeerId,
              kind: 'video',
              source: 'screen',
              rtpCapabilities: device.rtpCapabilities,
            },
            resolve,
          ),
        )
        if (!params?.id) {
          console.warn('Failed to consume screen share from', sharerPeerId)
          return
        }

        const consumer = await recvTransport.consume(
          params as Parameters<typeof recvTransport.consume>[0],
        )
        videoConsumerRef.current = consumer

        await new Promise<void>((resolve) =>
          socket.emit('voice:resumeConsumer', { channelId, consumerId: consumer.id }, () =>
            resolve(),
          ),
        )
        await consumer.resume()

        const videoEl = document.createElement('video')
        videoEl.autoplay = true
        videoEl.playsInline = true
        videoEl.muted = true
        videoEl.srcObject = new MediaStream([consumer.track])
        videoEl.style.width = '100%'
        videoEl.style.height = '100%'
        await videoEl.play().catch((err) => {
          console.error('Failed to play screen share video:', err)
        })
        videoElRef.current = videoEl

        setScreenSharePeer(sharerPeerId, username)
      } catch (err) {
        console.error('Failed to consume screen share:', err)
      }
    },
    [setScreenSharePeer],
  )

  const stopScreenConsume = useCallback(() => {
    videoConsumerRef.current?.close()
    videoConsumerRef.current = null
    if (videoElRef.current) {
      videoElRef.current.pause()
      videoElRef.current.srcObject = null
      videoElRef.current = null
    }
    clearScreenSharePeer()
  }, [clearScreenSharePeer])

  const consumeCamera = useCallback(
    async (
      socket: Socket,
      device: Device,
      recvTransport: Transport,
      peerId: string,
      channelId: string,
    ) => {
      if (cameraConsumersRef.current.has(peerId)) return
      try {
        const params: Record<string, unknown> = await new Promise((resolve) =>
          socket.emit(
            'voice:consume',
            {
              channelId,
              peerId,
              kind: 'video',
              source: 'camera',
              rtpCapabilities: device.rtpCapabilities,
            },
            resolve,
          ),
        )
        if (!params?.id) {
          console.warn('Failed to consume camera from', peerId)
          return
        }

        const consumer = await recvTransport.consume(
          params as Parameters<typeof recvTransport.consume>[0],
        )
        cameraConsumersRef.current.set(peerId, consumer)

        await new Promise<void>((resolve) =>
          socket.emit('voice:resumeConsumer', { channelId, consumerId: consumer.id }, () =>
            resolve(),
          ),
        )
        await consumer.resume()

        setPeerCameraStream(peerId, new MediaStream([consumer.track]))
      } catch (err) {
        console.error('Failed to consume camera:', err)
      }
    },
    [setPeerCameraStream],
  )

  const stopCameraConsume = useCallback(
    (peerId: string) => {
      const consumer = cameraConsumersRef.current.get(peerId)
      if (consumer) {
        consumer.close()
        cameraConsumersRef.current.delete(peerId)
      }
      removePeerCameraStream(peerId)
    },
    [removePeerCameraStream],
  )

  const nativeVoiceUnlistenRef = useRef<(() => void) | null>(null)
  const nativeSpeakingUnlistenRef = useRef<(() => void) | null>(null)
  const nativeInitializedRef = useRef(false)
  const nativePeerHandlersRef = useRef<boolean>(false)

  /**
   * The single source of truth for whether the mic is transmitting. Mute and
   * push-to-talk both feed into it, so the two can never disagree: muting while
   * the PTT key is held keeps you silent, and releasing the key afterwards does
   * not quietly un-mute you. Applies to whichever backend carries the call.
   */
  const applyMicTransmit = useCallback(async (): Promise<boolean> => {
    const { isMuted: muted, voiceInputMode: mode } = useVoiceStore.getState()
    const transmitting = !muted && (mode !== 'push-to-talk' || pttPressedRef.current)
    if (isTauri() && !isMobileTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('voice_set_muted', { muted: !transmitting })
      } catch (e) {
        verr('micTransmit', 'voice_set_muted failed', e)
      }
    } else if (producerRef.current) {
      if (transmitting) producerRef.current.resume()
      else producerRef.current.pause()
    }
    return transmitting
  }, [])

  /**
   * Push-to-talk key handling, registered for every backend. The native path
   * gates transmission through `voice_set_muted` rather than by pausing a
   * mediasoup producer, so this cannot live inside the browser mic setup —
   * when it did, desktop users who picked push-to-talk got no key handling at
   * all and (because the mute button also no-ops in that mode) a permanently
   * open mic.
   */
  const setupPushToTalkListeners = useCallback(() => {
    pttCleanupRef.current?.()
    pttPressedRef.current = false

    const emitSpeaking = (speaking: boolean) => {
      setIsSpeaking(speaking)
      const channelId = channelIdRef.current
      if (channelId) socketRef.current?.emit('voice:speaking', { channelId, speaking })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== pushToTalkKey || e.repeat || pttPressedRef.current) return
      if (!isEditableTarget(e.target)) e.preventDefault()
      pttPressedRef.current = true
      applyMicTransmit().then(emitSpeaking)
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== pushToTalkKey || !pttPressedRef.current) return
      pttPressedRef.current = false
      applyMicTransmit().then(() => emitSpeaking(false))
    }
    // A window that loses focus mid-press never delivers the keyup, which would
    // otherwise latch the mic open until the key is pressed and released again.
    const handleBlur = () => {
      if (!pttPressedRef.current) return
      pttPressedRef.current = false
      applyMicTransmit().then(() => emitSpeaking(false))
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    pttCleanupRef.current = () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [pushToTalkKey, setIsSpeaking, applyMicTransmit, socketRef])

  /**
   * Apply the current input mode to a live call. Called once a join completes
   * and again whenever the mode or key changes mid-call.
   */
  const armInputMode = useCallback(async () => {
    pttCleanupRef.current?.()
    pttCleanupRef.current = null
    pttPressedRef.current = false
    if (useVoiceStore.getState().voiceInputMode === 'push-to-talk') {
      setupPushToTalkListeners()
      setIsSpeaking(false)
    }
    await applyMicTransmit()
  }, [setupPushToTalkListeners, applyMicTransmit, setIsSpeaking])

  const initNativeVoice = useCallback(async () => {
    if (nativeInitializedRef.current) return
    if (!session) return
    vlog('voice_init', `connecting to ${session.url} as ${session.user.username}`)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('voice_init', {
        serverUrl: session.url,
        userId: session.user.id,
        username: session.user.username,
      })
      nativeInitializedRef.current = true
      vlog('voice_init', 'Rust voice backend initialized')
    } catch (e) {
      verr('voice_init', 'Failed to init native voice', e)
      nativeInitializedRef.current = false
    }
  }, [session])

  const setupNativeVoiceListeners = useCallback((): Promise<void> => {
    nativeVoiceUnlistenRef.current?.()
    nativeSpeakingUnlistenRef.current?.()
    return import('@tauri-apps/api/event')
      .then(({ listen }) =>
        Promise.all([
          listen<VoiceEventPayload>('voice:event', (event) => {
            const ev = event.payload
            vlog('voice:event', `type=${ev.type}`, ev)
            switch (ev.type) {
              case 'State': {
                const data = ev.data
                vlog('voice:state', `state=${data.state} error=${data.error || 'none'}`)
                if (data.state === 'active' || data.state === 'joined') {
                  setActiveVoiceChannel(channelIdRef.current!)
                } else if (data.state === 'failed' || data.state === 'disconnected') {
                  if (data.error) {
                    verr('voice:state', data.error)
                    setVoiceError(data.error)
                  }
                }
                break
              }
              case 'PeerJoined': {
                addVoicePeer({
                  id: ev.data.peer_id!,
                  userId: ev.data.user_id!,
                  username: ev.data.username!,
                  speaking: false,
                  muted: false,
                })
                break
              }
              case 'PeerLeft': {
                removeVoicePeer(ev.data.peer_id!)
                import('@tauri-apps/api/core').then(({ invoke }) =>
                  invoke('voice_remove_peer', { peerId: ev.data.peer_id }).catch((err) => {
                    console.error('Failed to remove voice peer (native):', err)
                  }),
                )
                break
              }
              case 'PeerSpeaking': {
                updateVoicePeer(ev.data.peer_id!, { speaking: ev.data.speaking })
                break
              }
              case 'ScreenShareStarted': {
                setScreenSharePeer(ev.data.peer_id!, ev.data.username!)
                break
              }
              case 'ScreenShareStopped': {
                clearScreenSharePeer()
                break
              }
            }
          }).then((unlisten) => {
            nativeVoiceUnlistenRef.current = unlisten
          }),
          listen<VoiceSpeakingPayload>('voice:speaking', (event) => {
            const { channelId, speaking, level } = event.payload
            if (typeof level === 'number') {
              setLiveAudioLevel(level * 1000)
            }
            // In push-to-talk the key owns the speaking state; letting the
            // native VAD through as well would light the indicator for anyone
            // who breathed near the mic without holding the key.
            if (useVoiceStore.getState().voiceInputMode === 'push-to-talk') return
            const socket = socketRef.current
            if (socket && channelId) {
              socket.emit('voice:speaking', { channelId, speaking })
            }
            setIsSpeaking(speaking)
          }).then((unlisten) => {
            nativeSpeakingUnlistenRef.current = unlisten
          }),
        ]).then(() => undefined),
      )
      .catch((e) => {
        verr('setupNativeVoice', 'Failed to setup voice listeners', e)
      })
  }, [
    addVoicePeer,
    removeVoicePeer,
    updateVoicePeer,
    setActiveVoiceChannel,
    setVoiceError,
    setScreenSharePeer,
    clearScreenSharePeer,
    setIsSpeaking,
    socketRef,
  ])

  const joinVoiceNative = useCallback(
    async (channelId: string): Promise<string | null> => {
      const socket = socketRef.current
      if (!session) {
        const err = 'No active session'
        setVoiceError(err)
        return err
      }

      vlog('joinVoiceNative', `joining channel=${channelId} url=${session.url}`)
      cleanupVoice()
      channelIdRef.current = channelId
      setVoiceError(null)

      await initNativeVoice()
      await setupNativeVoiceListeners()

      const { invoke } = await import('@tauri-apps/api/core')

      // Set up chat socket peer event handlers
      if (socket && !nativePeerHandlersRef.current) {
        nativePeerHandlersRef.current = true
        socket.on(
          'voice:newPeer',
          async (peer: { peerId: string; userId: string; username: string }) => {
            vlog('nativePeer', `voice:newPeer peerId=${peer.peerId}`)
            addVoicePeer({
              id: peer.peerId,
              userId: peer.userId,
              username: peer.username,
              speaking: false,
              muted: false,
            })
            try {
              const consumeResult: ConsumeResult = await new Promise((resolve) =>
                socket!.emit(
                  'voice:consume',
                  {
                    channelId: channelIdRef.current,
                    peerId: peer.peerId,
                    rtpCapabilities: {
                      codecs: [
                        {
                          mimeType: 'audio/opus',
                          clockRate: 48000,
                          channels: 2,
                          parameters: { useinbandfec: 1, minptime: 10 },
                          rtcpFeedback: [],
                        },
                      ],
                      headerExtensions: [],
                    },
                  },
                  resolve,
                ),
              )
              if (consumeResult?.error) {
                verr('nativePeer', `consume ${peer.peerId} failed: ${consumeResult.error}`)
              } else {
                const ssrc = consumeResult?.rtpParameters?.encodings?.[0]?.ssrc ?? 0
                const { invoke: inv } = await import('@tauri-apps/api/core')
                await inv('voice_add_peer', { peerId: peer.peerId, ssrc })
                socket!.emit('voice:resumeConsumer', {
                  channelId: channelIdRef.current,
                  consumerId: consumeResult.id,
                })
                // Push this peer's saved volume to the mixer now they exist in it.
                applyOutputVolumes()
              }
            } catch (e) {
              verr('nativePeer', `consume ${peer.peerId} error`, e)
            }
          },
        )
        socket.on('voice:peerLeft', ({ peerId }: { peerId: string }) => {
          removeVoicePeer(peerId)
          invoke('voice_remove_peer', { peerId }).catch((err) => {
            console.error('Failed to remove voice peer (socket handler):', err)
          })
        })
        socket.on(
          'voice:peerSpeaking',
          ({ peerId, speaking }: { peerId: string; speaking: boolean }) => {
            updateVoicePeer(peerId, { speaking })
          },
        )
        socket.on('voice:mute', ({ peerId, muted }: { peerId: string; muted: boolean }) => {
          updateVoicePeer(peerId, { muted })
        })
        socket.on(
          'server:voiceBitrateChanged',
          ({ voiceBitrateKbps: newKbps }: { voiceBitrateKbps: number }) => {
            vlog('bitrate', `server:voiceBitrateChanged -> ${newKbps} kbps`)
            serverBitrateRef.current = newKbps
            setServerVoiceBitrateKbps(newKbps)
            import('@tauri-apps/api/core').then(({ invoke }) =>
              invoke('voice_update_bitrate', { voiceBitrateKbps: newKbps }).catch((e) =>
                verr('bitrate', 'voice_update_bitrate failed', e),
              ),
            )
          },
        )
      }

      try {
        // Step 1: voice:join via chat socket
        vlog('joinVoiceNative', 'sending voice:join via chat socket')
        const joinResult: VoiceJoinResult = await new Promise((resolve) =>
          socket!.emit('voice:join', { channelId }, resolve),
        )
        if (joinResult?.error) {
          throw new Error(`voice:join failed: ${joinResult.error}`)
        }
        vlog('joinVoiceNative', 'voice:join OK', {
          peers: joinResult?.peers?.length,
          bitrate: joinResult?.voiceBitrateKbps,
        })

        setActiveVoiceChannel(channelId)
        useVoiceStore.getState().setRouterRtpCapabilities(joinResult.routerRtpCapabilities!)

        // Enable Socket.IO RTP forwarding as fallback for broken recv DTLS.
        // Framing 2 prefixes each payload with the RTP sequence number and
        // timestamp, which the native jitter buffer needs to reorder packets,
        // drive Opus inband FEC, and tell a DTX pause from real loss. Servers
        // that predate it never ack, so fall back to bare payloads.
        const framing = await new Promise<number>((resolve) => {
          const timer = setTimeout(() => resolve(1), 2000)
          socket!.emit('voice:enableSocketRtp', { framing: 2 }, (res?: { framing?: number }) => {
            clearTimeout(timer)
            resolve(res?.framing === 2 ? 2 : 1)
          })
        })
        vlog('joinVoiceNative', `enabled socket RTP forwarding (framing=${framing})`)
        if (framing < 2) {
          vlog('joinVoiceNative', 'server predates RTP seq forwarding — FEC/reordering disabled')
        }

        // Hoisted out of the packet handler: this fires ~50x/sec per peer, and
        // the payload goes over IPC as a raw body rather than a JSON number array.
        const { invoke: injectInvoke } = await import('@tauri-apps/api/core')
        const injectHeaders: Record<string, Record<string, string>> = {}
        socket?.on('voice:socketRtp', (payload: ArrayBuffer, peerId: string) => {
          let headers = injectHeaders[peerId]
          if (!headers) {
            headers = { 'x-peer-id': peerId, 'x-framing': String(framing) }
            injectHeaders[peerId] = headers
          }
          injectInvoke('voice_inject_opus', payload, { headers }).catch((err) => {
            console.error('Failed to inject opus data:', err)
          })
        })

        const iceServers = joinResult.iceServers || []
        const voiceBitrateKbps = joinResult.voiceBitrateKbps ?? 64
        serverBitrateRef.current = voiceBitrateKbps
        setServerVoiceBitrateKbps(voiceBitrateKbps)

        useVoiceStore.getState().setIceServers(iceServers)

        // Step 2: create send transport via chat socket
        const sendParams: TransportResult = await new Promise((resolve) =>
          socket!.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
        )
        if (sendParams?.error) throw new Error(`send transport create: ${sendParams.error}`)
        vlog('joinVoiceNative', 'send transport created', { id: sendParams?.id })

        // Step 3: create DirectTransport for recv (no ICE/DTLS needed)
        const recvParams: TransportResult = await new Promise((resolve) =>
          socket!.emit('voice:createDirectTransport', { channelId }, resolve),
        )
        if (recvParams?.error) throw new Error(`recv direct transport create: ${recvParams.error}`)
        vlog('joinVoiceNative', 'recv direct transport created', { id: recvParams?.id })

        // Step 4: create WebRTC send transport in Rust (recv uses DirectTransport, no Rust PC needed)
        vlog('joinVoiceNative', 'calling voice_begin')
        const [sendDtls, _recvDtls, audioRtpParams, videoRtpParams] = (await invoke('voice_begin', {
          channelId,
          iceServers,
          sendParams,
          recvParams,
          voiceBitrateKbps,
        })) as [
          Record<string, unknown>,
          Record<string, unknown>,
          Record<string, unknown>,
          Record<string, unknown>,
        ]
        vlog('joinVoiceNative', 'voice_begin OK')

        // The video track exists on the Rust send transport from here on; the
        // screenshare hook produces it on the server the first time it is used.
        nativeVideoRef.current = {
          transportId: sendParams.id as string,
          rtpParameters: videoRtpParams,
          producerId: null,
        }

        // Step 5: connect send transport
        const sendConnectResult: TransportResult = await new Promise((resolve) =>
          socket!.emit(
            'voice:connectTransport',
            {
              channelId,
              transportId: sendParams.id,
              dtlsParameters: sendDtls,
            },
            resolve,
          ),
        )
        if (sendConnectResult?.error)
          throw new Error(`send connectTransport: ${sendConnectResult.error}`)
        vlog('joinVoiceNative', 'send connectTransport OK')

        // Step 6: produce audio
        const produceResult: TransportResult = await new Promise((resolve) =>
          socket!.emit(
            'voice:produce',
            {
              channelId,
              transportId: sendParams.id,
              kind: 'audio',
              rtpParameters: audioRtpParams,
            },
            resolve,
          ),
        )
        if (produceResult?.error) throw new Error(`audio produce: ${produceResult.error}`)
        vlog('joinVoiceNative', 'audio produce OK', { producerId: produceResult?.id })

        // Step 8: start audio capture in Rust with DSP config
        const gateDb = gateSliderToDb(noiseGateThreshold)
        // RNNoise runs at full strength (a dry/wet blend would comb-filter the
        // voice — see voice/rnnoise.rs). suppressionStrength only affects the
        // legacy spectral suppressor, which the desktop path no longer selects.
        await invoke('voice_finish_join', {
          voiceBitrateKbps,
          gateEnabled: noiseGateEnabled,
          gateThresholdDb: gateDb,
          suppressionEnabled: noiseSuppression,
          suppressionStrength: 1.0,
          autoGainEnabled: autoGainControl,
          deviceName: audioInputDeviceId || null,
          outputDeviceId: audioOutputDeviceId || null,
        })
        vlog('joinVoiceNative', 'finish_join OK')

        // Native AEC3, applied to the capture stream against the mix we play
        // out. Unlike the browser path this doesn't reopen the mic on the OS
        // communications device, so it has no effect on other apps' audio.
        await invoke('voice_set_echo_cancellation', { enabled: echoCancellation })

        // Set initial volumes. Input gain is a preamp trim in the Rust DSP
        // chain; it is not part of finish_join's argument list.
        await invoke('voice_set_output_volume', { volume: outputVolume / 100 })
        await invoke('voice_set_input_volume', { volume: Math.max(0, inputVolume / 100) })

        // Step 9: consume existing peers
        if (joinResult.peers) {
          for (const peer of joinResult.peers) {
            addVoicePeer({
              id: peer.id,
              userId: peer.userId,
              username: peer.username,
              speaking: false,
              muted: peer.muted ?? false,
            })
            const consumeResult: ConsumeResult = await new Promise((resolve) =>
              socket!.emit(
                'voice:consume',
                {
                  channelId,
                  peerId: peer.id,
                  rtpCapabilities: joinResult.routerRtpCapabilities,
                },
                resolve,
              ),
            )
            if (consumeResult?.error) {
              verr('joinVoiceNative', `consume peer ${peer.id} failed: ${consumeResult.error}`)
            } else {
              const ssrc = consumeResult?.rtpParameters?.encodings?.[0]?.ssrc ?? 0
              await invoke('voice_add_peer', { peerId: peer.id, ssrc })
              socket!.emit('voice:resumeConsumer', { channelId, consumerId: consumeResult.id })
              vlog('joinVoiceNative', `consumed peer ${peer.id}`)
            }
          }
        }

        await invoke('voice_flush_peers')
        vlog('joinVoiceNative', 'flush_peers done')

        applyOutputVolumes()

        // Push-to-talk and mute apply to the native backend too — without this
        // the key does nothing here and the mic stays open.
        await armInputMode()

        return null
      } catch (e: unknown) {
        const err = (e as { toString?: () => string })?.toString?.() || 'Failed to join voice'
        verr('joinVoiceNative', 'failed', e)
        setVoiceError(err)
        socket?.emit('voice:leave', { channelId })
        try {
          await invoke('voice_leave')
        } catch (e) {
          console.error('Failed to leave voice after join error:', e)
        }
        channelIdRef.current = null
        return err
      }
    },
    [
      socketRef,
      session,
      cleanupVoice,
      setVoiceError,
      initNativeVoice,
      setupNativeVoiceListeners,
      setActiveVoiceChannel,
      addVoicePeer,
      audioInputDeviceId,
      audioOutputDeviceId,
      outputVolume,
      noiseGateEnabled,
      noiseGateThreshold,
      noiseSuppression,
      noiseSuppressionStrength,
      // autoGainControl was already read inside this callback but missing here,
      // so a join used whichever value was current when the callback last got
      // rebuilt rather than the user's actual setting.
      autoGainControl,
      echoCancellation,
      inputVolume,
      armInputMode,
      applyOutputVolumes,
    ],
  )

  const leaveVoiceNative = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('voice_leave')
    } catch (e) {
      verr('leaveVoice', 'Native leave failed', e)
    }
    const socket = socketRef.current
    if (socket) {
      socket.emit('voice:leave', { channelId: channelIdRef.current })
    }
    // Clean up chat socket peer handlers
    if (socket && nativePeerHandlersRef.current) {
      socket.off('voice:newPeer')
      socket.off('voice:peerLeft')
      socket.off('voice:peerSpeaking')
      socket.off('voice:mute')
      socket.off('voice:socketRtp')
      nativePeerHandlersRef.current = false
    }
    nativeVoiceUnlistenRef.current?.()
    nativeVoiceUnlistenRef.current = null
    nativeSpeakingUnlistenRef.current?.()
    nativeSpeakingUnlistenRef.current = null
    channelIdRef.current = null
    setVoicePeers([])
    setIsSpeaking(false)
    setLocalConnectionQuality(null)
    setLiveAudioLevel(0)
    clearScreenSharePeer()
  }, [setVoicePeers, setIsSpeaking, setLocalConnectionQuality, clearScreenSharePeer, socketRef])

  const joinVoiceInternal = useCallback(
    async (channelId: string): Promise<string | null> => {
      vlog(
        'joinVoice',
        `starting | channelId=${channelId} | isTauri=${isTauri()} | socket=${!!socketRef.current} | session=${!!session}`,
      )

      if (isTauri() && !isMobileTauri()) {
        return joinVoiceNative(channelId)
      }

      const socket = socketRef.current
      if (!socket || !session) {
        const err = 'No socket connection'
        setVoiceError(err)
        return err
      }

      cleanupVoice()
      channelIdRef.current = channelId
      setVoiceError(null)

      vlog('joinVoice', 'emitting voice:join')
      const joinResult: VoiceJoinResult = await new Promise((resolve) =>
        socket.emit('voice:join', { channelId }, resolve),
      )

      if (joinResult?.error) {
        verr('joinVoice', 'voice:join error', joinResult.error as string)
        setVoiceError(joinResult.error as string)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return joinResult.error
      }
      if (!joinResult?.routerRtpCapabilities) {
        verr('joinVoice', 'no routerRtpCapabilities in response', joinResult)
        const err = 'Failed to join voice channel'
        setVoiceError(err)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return err
      }

      setActiveVoiceChannel(channelId)
      useVoiceStore.getState().setRouterRtpCapabilities(joinResult.routerRtpCapabilities)

      if (typeof RTCPeerConnection === 'undefined') {
        verr('joinVoice', 'RTCPeerConnection undefined - WebRTC not supported')
        const err =
          'WebRTC is not supported in this browser. On Linux, ensure webkit2gtk is built with WebRTC support, or use Chromium/Firefox via pnpm dev:desktop.'
        setVoiceError(err)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return err
      }

      vlog('joinVoice', 'creating mediasoup Device and loading rtpCapabilities')
      let device: Device
      try {
        device = new Device()
        await device.load({ routerRtpCapabilities: joinResult.routerRtpCapabilities })
      } catch (loadErr: unknown) {
        verr('joinVoice', 'mediasoup Device.load() failed', loadErr)
        const e = loadErr as { message?: string }
        const err = `WebRTC codec/device initialization failed: ${e?.message || loadErr}. On Linux, ensure webkit2gtk is built with full WebRTC support and required audio codecs (opus) are available.`
        setVoiceError(err)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return err
      }
      vlog('joinVoice', 'Device loaded successfully')
      deviceRef.current = device

      const iceServers = joinResult.iceServers || []

      useVoiceStore.getState().setIceServers(iceServers)

      vlog('joinVoice', 'creating send transport')
      const sendParams: Record<string, unknown> = await new Promise((resolve) =>
        socket.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
      )
      if (sendParams?.error) {
        verr('joinVoice', 'send transport create failed', sendParams.error as string)
        const err = `Send transport failed: ${sendParams.error}`
        setVoiceError(err)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return err
      }
      vlog('joinVoice', 'send transport created', { id: sendParams?.id })

      const sendTransport = device.createSendTransport({
        ...sendParams,
        iceServers: iceServers.length > 0 ? iceServers : undefined,
      } as Parameters<typeof device.createSendTransport>[0])
      sendTransportRef.current = sendTransport

      sendTransport.on('connect', ({ dtlsParameters }, cb) => {
        vlog('transport', 'send connect event')
        socket.emit(
          'voice:connectTransport',
          { channelId, transportId: sendTransport.id, dtlsParameters },
          cb,
        )
      })
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb) => {
        const source = (appData as { source?: 'camera' | 'screen' })?.source
        vlog('transport', `send produce event kind=${kind}${source ? ` source=${source}` : ''}`)
        socket.emit(
          'voice:produce',
          { channelId, transportId: sendTransport.id, kind, rtpParameters, source },
          cb,
        )
      })

      sendTransport.on('connectionstatechange', (state) => {
        vlog('transport', `send connectionstatechange -> ${state}`)
        if (state === 'failed' || state === 'closed') {
          verr('transport', `send transport state: ${state}`)
          handleTransportFailure(socket, channelId)
        }
        if (state === 'connected') {
          if (iceTimerRef.current) {
            clearTimeout(iceTimerRef.current)
            iceTimerRef.current = null
          }
        }
      })

      vlog('joinVoice', 'creating recv transport')
      const recvParams: Record<string, unknown> = await new Promise((resolve) =>
        socket.emit('voice:createTransport', { channelId, direction: 'recv' }, resolve),
      )
      if (recvParams?.error) {
        verr('joinVoice', 'recv transport create failed', recvParams.error as string)
        const err = `Recv transport failed: ${recvParams.error}`
        setVoiceError(err)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return err
      }
      vlog('joinVoice', 'recv transport created', { id: recvParams?.id })

      const recvTransport = device.createRecvTransport({
        ...recvParams,
        iceServers: iceServers.length > 0 ? iceServers : undefined,
      } as Parameters<typeof device.createRecvTransport>[0])
      recvTransportRef.current = recvTransport

      recvTransport.on('connect', ({ dtlsParameters }, cb) => {
        vlog('transport', 'recv connect event')
        socket.emit(
          'voice:connectTransport',
          { channelId, transportId: recvTransport.id, dtlsParameters },
          cb,
        )
      })

      recvTransport.on('connectionstatechange', (state) => {
        vlog('transport', `recv connectionstatechange -> ${state}`)
        if (state === 'failed' || state === 'closed') {
          verr('transport', `recv transport state: ${state}`)
          handleTransportFailure(socket, channelId)
        }
        if (state === 'connected') {
          if (iceTimerRef.current) {
            clearTimeout(iceTimerRef.current)
            iceTimerRef.current = null
          }
        }
      })

      if (iceTimerRef.current) clearTimeout(iceTimerRef.current)
      iceTimerRef.current = setTimeout(() => {
        const sendState = sendTransportRef.current?.connectionState ?? '?'
        const recvState = recvTransportRef.current?.connectionState ?? '?'
        const iceWarning = `ICE negotiation timed out after 12s (send=${sendState}, recv=${recvState}). \
This usually means the server's PUBLIC_ADDRESS is misconfigured (pointing to localhost or unreachable). \
Ensure PUBLIC_ADDRESS in the server .env is set to the server's actual public IP, or leave it blank for auto-detection.`
        verr('joinVoice', iceWarning)
        setVoiceError(iceWarning)
      }, 12000)

      socket.on(
        'voice:newPeer',
        async (peer: { peerId: string; userId: string; username: string }) => {
          vlog('peer', `voice:newPeer peerId=${peer.peerId} userId=${peer.userId}`)
          await consumePeer(
            socket,
            device,
            recvTransport,
            peer.peerId,
            channelId,
            remoteAudioCtxRef.current!,
          )
          addVoicePeer({
            id: peer.peerId,
            userId: peer.userId,
            username: peer.username,
            speaking: false,
            muted: false,
          })
        },
      )

      socket.on('voice:peerLeft', ({ peerId }: { peerId: string }) => {
        vlog('peer', `voice:peerLeft peerId=${peerId}`)

        consumersRef.current.get(peerId)?.close()
        consumersRef.current.delete(peerId)
        const leavingEl = audioElemsRef.current.get(peerId)
        if (leavingEl) {
          leavingEl.pause()
          leavingEl.srcObject = null
        }
        audioElemsRef.current.delete(peerId)
        peerGainNodesRef.current.get(peerId)?.disconnect()
        peerGainNodesRef.current.delete(peerId)
        remoteSpeakingCleanupsRef.current.get(peerId)?.()
        remoteSpeakingCleanupsRef.current.delete(peerId)
        const peerQInt = peerQualityIntervalsRef.current.get(peerId)
        if (peerQInt != null) clearInterval(peerQInt)
        peerQualityIntervalsRef.current.delete(peerId)
        stopCameraConsume(peerId)
        removeVoicePeer(peerId)
      })

      socket.on(
        'voice:peerSpeaking',
        ({ peerId, speaking }: { peerId: string; speaking: boolean }) => {
          updateVoicePeer(peerId, { speaking })
        },
      )

      socket.on('voice:mute', ({ peerId, muted }: { peerId: string; muted: boolean }) => {
        updateVoicePeer(peerId, { muted })
      })

      socket.on(
        'screen:peerStarted',
        async (data: { peerId: string; userId: string; username: string }) => {
          await consumeScreenShare(
            socket,
            device,
            recvTransport,
            data.peerId,
            channelId,
            data.username,
          )
        },
      )

      socket.on('screen:peerStopped', () => {
        stopScreenConsume()
      })

      socket.on(
        'camera:peerStarted',
        async (data: { peerId: string; userId: string; username: string }) => {
          await consumeCamera(socket, device, recvTransport, data.peerId, channelId)
        },
      )

      socket.on('camera:peerStopped', ({ peerId }: { peerId: string }) => {
        stopCameraConsume(peerId)
      })

      socket.on('voice:consumerClosed', ({ consumerId }: { consumerId: string }) => {
        if (videoConsumerRef.current?.id === consumerId) {
          stopScreenConsume()
        }
      })

      // Pin to 48kHz to match the Opus/RTP pipeline. Without this the context
      // falls back to the system default (often 44.1kHz), forcing the browser to
      // resample remote voice and introducing artifacts.
      const remoteCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
      remoteAudioCtxRef.current = remoteCtx
      vlog(
        'joinVoice',
        `remote AudioContext created | state=${remoteCtx.state} | sampleRate=${remoteCtx.sampleRate}`,
      )

      for (const peer of joinResult.peers || []) {
        const socketId = peer.id
        await consumePeer(socket, device, recvTransport, socketId, channelId, remoteCtx)
        addVoicePeer({
          id: socketId,
          userId: peer.userId,
          username: peer.username,
          speaking: false,
          muted: false,
        })
      }

      if (joinResult.screenSharePeer) {
        const { peerId, username } = joinResult.screenSharePeer
        await consumeScreenShare(socket, device, recvTransport, peerId, channelId, username)
      }

      for (const peer of joinResult.peers || []) {
        if (peer.hasCamera) {
          await consumeCamera(socket, device, recvTransport, peer.id, channelId)
        }
      }

      const voiceBitrateKbps = joinResult.voiceBitrateKbps ?? 64
      serverBitrateRef.current = voiceBitrateKbps
      setServerVoiceBitrateKbps(voiceBitrateKbps)

      socket.on(
        'server:voiceBitrateChanged',
        ({ voiceBitrateKbps: newKbps }: { voiceBitrateKbps: number }) => {
          vlog('bitrate', `server:voiceBitrateChanged -> ${newKbps} kbps`)
          serverBitrateRef.current = newKbps
          setServerVoiceBitrateKbps(newKbps)
          if (producerRef.current) {
            producerRef.current
              .setRtpEncodingParameters({ maxBitrate: newKbps * 1000 })
              .catch(console.error)
          }
        },
      )

      try {
        vlog('mic', 'taking BROWSER microphone path')
        await setupBrowserMicrophone(socket, channelId, sendTransport, voiceBitrateKbps)
        vlog('joinVoice', 'microphone setup complete - voice joined successfully')
      } catch (err: unknown) {
        verr('joinVoice', `microphone setup FAILED (isTauri=${isTauri()})`, err)
        console.error('Microphone access error', err)
        const e = err as Error & { name?: string }
        let errorMsg: string
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          errorMsg = 'Microphone access was denied. Please allow microphone access and try again.'
        } else if (e.name === 'NotFoundError') {
          errorMsg = 'No microphone found. Please connect a microphone and try again.'
        } else if (
          e.name === 'NotReadableError' ||
          e.name === 'OverconstrainedError' ||
          e.message?.includes('timed out')
        ) {
          errorMsg =
            'Microphone is unavailable or in use by another application. On Linux, ensure pipewire-pulse and pipewire-alsa are installed and running.'
        } else {
          const msg =
            e.message || (e as { toString?: () => string }).toString?.() || 'Unknown error'
          const linuxHint =
            navigator.platform?.toLowerCase().includes('linux') || isTauri()
              ? ' On Linux, ensure pipewire, pipewire-pulse, and pipewire-alsa are installed and your user session is running PipeWire.'
              : ''
          errorMsg = `Failed to access microphone: ${msg}.${linuxHint}`
        }
        setVoiceError(errorMsg)
        cleanupVoice()
        socket.emit('voice:leave', { channelId })
        channelIdRef.current = null
        return errorMsg
      }

      if (qualityIntervalRef.current != null) clearInterval(qualityIntervalRef.current)
      const pollLocalQuality = async () => {
        if (!sendTransportRef.current) return
        try {
          const stats = await sendTransportRef.current.getStats()
          setLocalConnectionQuality(computeQualityFromStats(stats))
        } catch (err) {
          console.error('Failed to get local transport stats:', err)
        }
      }
      pollLocalQuality()
      qualityIntervalRef.current = setInterval(pollLocalQuality, QUALITY_POLL_MS)

      reconnectAttemptsRef.current = 0
      return null
    },
    [
      socketRef,
      session,
      cleanupVoice,
      setActiveVoiceChannel,
      setVoicePeers,
      addVoicePeer,
      removeVoicePeer,
      updateVoicePeer,
      setIsSpeaking,
      setLocalConnectionQuality,
      serverVoiceBitrateKbps,
      setServerVoiceBitrateKbps,
      audioInputDeviceId,
      audioOutputDeviceId,
      setVoiceError,
      consumePeer,
      consumeScreenShare,
      stopScreenConsume,
      setScreenSharePeer,
      consumeCamera,
      stopCameraConsume,
      voiceInputMode,
      pushToTalkKey,
      noiseSuppression,
      autoGainControl,
      echoCancellation,
      noiseGateEnabled,
      noiseGateThreshold,
      noiseSuppressionStrength,
      inputVolume,
    ],
  )

  /**
   * Public join entry point. Publishes a "connecting" channel id for the whole
   * negotiation — transports, DTLS and the microphone all come up well after
   * the server accepts the join, and the UI used to claim the call was live for
   * that entire window, so people started talking into a mic that wasn't
   * producing yet.
   */
  const joinVoice = useCallback(
    async (channelId: string): Promise<string | null> => {
      setVoiceConnectingChannelId(channelId)
      try {
        return await joinVoiceInternal(channelId)
      } finally {
        setVoiceConnectingChannelId(null)
      }
    },
    [joinVoiceInternal, setVoiceConnectingChannelId],
  )

  const setupBrowserMicrophone = useCallback(
    async (socket: Socket, channelId: string, sendTransport: Transport, bitrateKbps: number) => {
      vlog(
        'browserMic',
        `starting | inputDeviceId=${audioInputDeviceId} | inputVolume=${inputVolume} | noiseSupp=${noiseSuppression} | agc=${autoGainControl} | bitrate=${bitrateKbps}`,
      )
      // Let the browser's built-in (well-tuned) WebRTC audio processing handle
      // echo cancellation, noise suppression and AGC. The custom worklet below
      // only applies the optional noise gate — the old multiband suppressor and
      // worklet AGC were broken (coloration + speech-as-noise) and double-processed.
      const baseAudioProcessing = {
        echoCancellation: { ideal: echoCancellation },
        noiseSuppression: { ideal: noiseSuppression },
        autoGainControl: { ideal: autoGainControl },
      }
      const micConstraints: MediaTrackConstraints = audioInputDeviceId
        ? { deviceId: { exact: audioInputDeviceId }, ...baseAudioProcessing }
        : { ...baseAudioProcessing }

      vlog('browserMic', 'calling getUserMedia')
      let stream: MediaStream
      try {
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ audio: micConstraints }),
          new Promise<MediaStream>((_, reject) =>
            setTimeout(() => reject(new Error('Microphone access timed out')), 5000),
          ),
        ])
      } catch (err: unknown) {
        const e = err as Error & { name?: string }
        if (
          audioInputDeviceId &&
          (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')
        ) {
          vlog(
            'browserMic',
            `stale device ${audioInputDeviceId}, retrying without device constraint`,
          )
          setAudioInputDeviceId(null)
          stream = await Promise.race([
            navigator.mediaDevices.getUserMedia({
              audio: { ...baseAudioProcessing },
            }),
            new Promise<MediaStream>((_, reject) =>
              setTimeout(() => reject(new Error('Microphone access timed out')), 5000),
            ),
          ])
        } else {
          throw err
        }
      }
      vlog(
        'browserMic',
        `getUserMedia OK | audioTracks=${stream.getAudioTracks().length} | track0=${stream.getAudioTracks()[0]?.label}`,
      )
      micStreamRef.current = stream
      const audioCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
      audioCtxRef.current = audioCtx
      vlog(
        'browserMic',
        `AudioContext created | state=${audioCtx.state} | sampleRate=${audioCtx.sampleRate}`,
      )
      const source = audioCtx.createMediaStreamSource(stream)
      const gainNode = audioCtx.createGain()
      // The slider goes to 200%; a GainNode handles gain > 1 and the browser's
      // own limiter plus Opus encoding absorb the headroom. Clamping this to 1.0
      // is what made every value above 100% do nothing.
      gainNode.gain.value = Math.max(0, inputVolume / 100)
      gainNodeRef.current = gainNode
      const destination = audioCtx.createMediaStreamDestination()

      // Load AudioWorklet for DSP (noise gate + spectral suppression)
      let workletNode: AudioWorkletNode | null = null
      const workletRef = { current: null as AudioWorkletNode | null }
      try {
        await audioCtx.audioWorklet.addModule('/audio-processor.js')
        workletNode = new AudioWorkletNode(audioCtx, 'audio-processor', {
          parameterData: {
            gateEnabled: noiseGateEnabled ? 1 : 0,
            gateThresholdDb: gateSliderToDb(noiseGateThreshold),
            // Suppression and AGC are handled by the browser's getUserMedia
            // processing above; the broken worklet implementations stay disabled.
            suppressionEnabled: 0,
            suppressionStrength: noiseSuppressionStrength / 100,
            agcEnabled: 0,
          },
        })
        workletRef.current = workletNode
        workletNodeRef.current = workletNode
        vlog('browserMic', 'AudioWorklet loaded and node created')
      } catch (e) {
        vlog('browserMic', `AudioWorklet unavailable, DSP disabled: ${String(e)}`)
      }

      // Audio graph: source -> worklet -> gain -> destination
      if (workletNode) {
        source.connect(workletNode)
        workletNode.connect(gainNode)
      } else {
        source.connect(gainNode)
      }
      gainNode.connect(destination)

      const processedTrack = destination.stream.getAudioTracks()[0]
      vlog(
        'browserMic',
        `creating producer | trackKind=${processedTrack.kind} | readyState=${processedTrack.readyState}`,
      )
      const producer = await sendTransport.produce({
        track: processedTrack,
        encodings: [{ maxBitrate: bitrateKbps * 1000 }],
        codecOptions: {
          opusStereo: false,
          opusDtx: true,
          opusFec: true,
          opusMaxAverageBitrate: bitrateKbps * 1000,
          opusMaxPlaybackRate: 48000,
        },
      })
      producerRef.current = producer
      vlog(
        'browserMic',
        `producer created | id=${producer.id} | kind=${producer.kind} | paused=${producer.paused}`,
      )

      localSpeakingCleanupRef.current?.()
      localSpeakingCleanupRef.current = startSpeakingDetection(
        stream,
        (speaking) => {
          // Read the mode live: push-to-talk drives speaking from the key, and
          // the user can switch modes without rejoining.
          const { voiceInputMode: mode, isMuted: muted } = useVoiceStore.getState()
          if (mode === 'push-to-talk') return
          if (muted && speaking) return
          setIsSpeaking(speaking)
          socket.emit('voice:speaking', { channelId, speaking })
        },
        (level) => setLiveAudioLevel(level),
        gainNode,
        audioCtx,
      )

      await armInputMode()
    },
    [
      audioInputDeviceId,
      noiseSuppression,
      autoGainControl,
      echoCancellation,
      noiseGateEnabled,
      noiseGateThreshold,
      noiseSuppressionStrength,
      inputVolume,
      voiceInputMode,
      setIsSpeaking,
      pushToTalkKey,
      setAudioInputDeviceId,
    ],
  )

  const handleTransportFailure = useCallback(
    (socket: Socket, channelId: string) => {
      if (isReconnectingRef.current) return
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error('Max reconnect attempts reached')
        setVoiceError('Connection lost. Please rejoin the voice channel.')
        cleanupVoice()
        return
      }
      isReconnectingRef.current = true
      reconnectAttemptsRef.current++
      setTimeout(async () => {
        if (!socket.connected) {
          isReconnectingRef.current = false
          return
        }
        cleanupVoice()
        try {
          const error = await joinVoice(channelId)
          if (error) {
            console.error('Reconnect failed:', error)
            setVoiceError(error)
          }
        } catch (err) {
          console.error('Reconnect error:', err)
          setVoiceError('Failed to reconnect to voice channel.')
        }
        isReconnectingRef.current = false
      }, RECONNECT_DELAY_MS * reconnectAttemptsRef.current)
    },
    [joinVoice, cleanupVoice, setVoiceError],
  )

  const leaveVoice = useCallback(async () => {
    const channelId = channelIdRef.current
    // Leaving is deliberate, so an in-flight reconnect must not resurrect the
    // call behind the user's back.
    rejoiningRef.current = true
    setVoiceReconnecting(false)
    setVoiceConnectingChannelId(null)
    if (isTauri() && !isMobileTauri()) {
      await leaveVoiceNative()
      setActiveVoiceChannel(null)
      setIsMuted(false)
      setVoiceError(null)
      rejoiningRef.current = false
      if (channelId?.startsWith('dm:')) {
        socketRef.current?.emit('dm:call:end', { dmChannelId: channelId.slice(3) })
        clearDMCall()
      }
      return
    }
    const socket = socketRef.current
    cleanupVoice()
    if (socket) {
      socket.off('voice:newPeer')
      socket.off('voice:peerLeft')
      socket.off('voice:peerSpeaking')
      socket.off('voice:mute')
      socket.off('screen:peerStarted')
      socket.off('screen:peerStopped')
      socket.off('camera:peerStarted')
      socket.off('camera:peerStopped')
      socket.off('voice:consumerClosed')
      stopScreenConsume()
      if (channelId?.startsWith('dm:')) {
        socket.emit('dm:call:end', { dmChannelId: channelId.slice(3) })
        clearDMCall()
      }
      socket.emit('voice:leave', { channelId: channelIdRef.current })
    }
    channelIdRef.current = null
    setActiveVoiceChannel(null)
    setIsMuted(false)
    setVoiceError(null)
    rejoiningRef.current = false
  }, [
    socketRef,
    cleanupVoice,
    setActiveVoiceChannel,
    setIsMuted,
    setVoiceError,
    leaveVoiceNative,
    clearDMCall,
    setVoiceReconnecting,
    setVoiceConnectingChannelId,
  ])

  /**
   * Mute works in every input mode, including push-to-talk, where it acts as an
   * override that outranks the key. Peers are told so their roster can show it.
   */
  const toggleMute = useCallback(async () => {
    const muted = !useVoiceStore.getState().isMuted
    setIsMuted(muted)
    const transmitting = await applyMicTransmit()
    const channelId = channelIdRef.current
    if (!transmitting) setIsSpeaking(false)
    if (channelId) {
      socketRef.current?.emit('voice:mute', { muted })
      if (!transmitting) socketRef.current?.emit('voice:speaking', { channelId, speaking: false })
    }
  }, [setIsMuted, setIsSpeaking, applyMicTransmit, socketRef])

  const startDMCall = useCallback(
    async (dmChannelId: string, otherUserId: string, otherUsername: string) => {
      const socket = socketRef.current
      if (!socket) return

      setDMCallStatus('ringing-outgoing')
      setDMCallChannelId(dmChannelId)
      setDMCallOtherUser(otherUserId, otherUsername)

      const result: Record<string, unknown> = await new Promise<Record<string, unknown>>(
        (resolve) => {
          const timeout = setTimeout(() => resolve({ error: 'Call timed out' }), 30_000)
          socket.emit('dm:call:start', { dmChannelId }, (res: Record<string, unknown>) => {
            clearTimeout(timeout)
            resolve(res)
          })
        },
      )

      if (result?.error) {
        clearDMCall()
        setVoiceError(result.error as string)
      }
    },
    [
      socketRef,
      setDMCallStatus,
      setDMCallChannelId,
      setDMCallOtherUser,
      clearDMCall,
      setVoiceError,
    ],
  )

  const acceptDMCall = useCallback(
    async (dmChannelId: string, otherUserId: string, otherUsername: string) => {
      const socket = socketRef.current
      if (!socket) return

      setIncomingCall(null)
      setDMCallStatus('active')
      setDMCallChannelId(dmChannelId)
      setDMCallOtherUser(otherUserId, otherUsername)

      const voiceChannelId = `dm:${dmChannelId}`
      socket.emit('dm:call:accept', { dmChannelId })
      const error = await joinVoice(voiceChannelId)
      if (error) {
        clearDMCall()
      }
    },
    [
      socketRef,
      setIncomingCall,
      setDMCallStatus,
      setDMCallChannelId,
      setDMCallOtherUser,
      joinVoice,
      clearDMCall,
    ],
  )

  const rejectDMCall = useCallback(
    (dmChannelId: string) => {
      const socket = socketRef.current
      if (!socket) return
      socket.emit('dm:call:reject', { dmChannelId })
      clearDMCall()
    },
    [socketRef, clearDMCall],
  )

  const endDMCall = useCallback(async () => {
    const socket = socketRef.current
    const channelId = dmCallChannelId
    if (!socket || !channelId) {
      await leaveVoice()
      clearDMCall()
      return
    }
    socket.emit('dm:call:end', { dmChannelId: channelId })
    await leaveVoice()
    clearDMCall()
  }, [socketRef, dmCallChannelId, leaveVoice, clearDMCall])

  const connectDMCall = useCallback(
    async (dmChannelId: string) => {
      const voiceChannelId = `dm:${dmChannelId}`
      const error = await joinVoice(voiceChannelId)
      if (error) {
        clearDMCall()
      }
    },
    [joinVoice, clearDMCall],
  )

  /**
   * Apply audio-processing settings to a live call. Every one of these has a
   * backend command that takes effect immediately, so changing them no longer
   * requires leaving and rejoining the channel. Input device is the exception —
   * it is bound when capture opens, and there is no command to re-point it.
   */
  const applyProcessingSettings = useCallback(async () => {
    if (!channelIdRef.current) return
    const s = useVoiceStore.getState()

    if (isTauri() && !isMobileTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      const call = (cmd: string, args: Record<string, unknown>) =>
        invoke(cmd, args).catch((err) => verr('settings', `${cmd} failed`, err))
      await Promise.all([
        call('voice_set_gate_enabled', { enabled: s.noiseGateEnabled }),
        call('voice_set_gate', { thresholdDb: gateSliderToDb(s.noiseGateThreshold) }),
        call('voice_set_noise_suppression', { enabled: s.noiseSuppression }),
        call('voice_set_auto_gain', { enabled: s.autoGainControl }),
        call('voice_set_echo_cancellation', { enabled: s.echoCancellation }),
        call('voice_set_input_volume', { volume: Math.max(0, s.inputVolume / 100) }),
      ])
      return
    }

    // Browser path: the noise gate lives in the worklet, and the rest are
    // getUserMedia constraints that can be re-applied to the live track.
    workletNodeRef.current?.parameters
      .get('gateEnabled')
      ?.setValueAtTime(s.noiseGateEnabled ? 1 : 0, 0)
    workletNodeRef.current?.parameters
      .get('gateThresholdDb')
      ?.setValueAtTime(gateSliderToDb(s.noiseGateThreshold), 0)
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = Math.max(0, s.inputVolume / 100)
    }
    const track = micStreamRef.current?.getAudioTracks()[0]
    if (track) {
      try {
        await track.applyConstraints({
          echoCancellation: { ideal: s.echoCancellation },
          noiseSuppression: { ideal: s.noiseSuppression },
          autoGainControl: { ideal: s.autoGainControl },
        })
      } catch (err) {
        vlog('settings', `applyConstraints failed (rejoin to apply): ${String(err)}`)
      }
    }
  }, [])

  /**
   * Route playback to the selected output device without a rejoin.
   */
  const applyOutputDevice = useCallback(async () => {
    if (!channelIdRef.current) return
    const deviceId = useVoiceStore.getState().audioOutputDeviceId
    if (isTauri() && !isMobileTauri()) {
      if (!deviceId) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('voice_set_output_device', { deviceId }).catch((err) =>
        verr('settings', 'voice_set_output_device failed', err),
      )
      return
    }
    for (const el of audioElemsRef.current.values()) {
      try {
        await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(
          deviceId ?? '',
        )
      } catch (e) {
        vlog('settings', `setSinkId failed or unsupported: ${String(e)}`)
      }
    }
  }, [])

  /**
   * The server drops a peer the moment its socket disconnects, so a sleep, a
   * wifi blip or a server restart silently ends the call: audio stops both ways
   * while the overlay still reads "Voice Connected" over a frozen roster.
   * Nothing rejoined on its own. Watch the socket flag the connection banner
   * already maintains and re-establish the call when it comes back.
   */
  useEffect(() => {
    return useSettingsStore.subscribe((state) => {
      const isConnected = state.socketConnected
      if (isConnected === socketWasConnectedRef.current) return
      socketWasConnectedRef.current = isConnected

      const channelId = channelIdRef.current
      if (!channelId) return

      if (!isConnected) {
        setVoiceReconnecting(true)
        setIsSpeaking(false)
        setVoicePeers([])
        setLocalConnectionQuality(null)
        return
      }

      if (rejoiningRef.current) return
      rejoiningRef.current = true
      ;(async () => {
        try {
          const error = await joinVoice(channelId)
          if (error) verr('reconnect', `voice rejoin failed: ${error}`)
        } catch (err) {
          verr('reconnect', 'voice rejoin threw', err)
        } finally {
          rejoiningRef.current = false
          setVoiceReconnecting(false)
        }
      })()
    })
  }, [joinVoice, setVoiceReconnecting, setIsSpeaking, setVoicePeers, setLocalConnectionQuality])

  // Keep a live call in sync with the settings panel. Zustand's subscribe fires
  // on every store write, so each concern is diffed against its own previous
  // value rather than re-applying everything on unrelated changes.
  useEffect(() => {
    let prev = useVoiceStore.getState()

    const unsub = useVoiceStore.subscribe((state) => {
      const was = prev
      prev = state

      if (state.inputVolume !== was.inputVolume) {
        if (gainNodeRef.current) {
          gainNodeRef.current.gain.value = Math.max(0, state.inputVolume / 100)
        }
        if (isTauri() && !isMobileTauri() && channelIdRef.current) {
          import('@tauri-apps/api/core').then(({ invoke }) =>
            invoke('voice_set_input_volume', {
              volume: Math.max(0, state.inputVolume / 100),
            }).catch((err) => verr('volume', 'voice_set_input_volume failed', err)),
          )
        }
      }

      if (state.outputVolume !== was.outputVolume || state.peerVolumes !== was.peerVolumes) {
        applyOutputVolumes()
      }

      if (
        state.voiceInputMode !== was.voiceInputMode ||
        state.pushToTalkKey !== was.pushToTalkKey
      ) {
        if (channelIdRef.current) armInputMode()
      }

      if (
        state.noiseGateEnabled !== was.noiseGateEnabled ||
        state.noiseGateThreshold !== was.noiseGateThreshold ||
        state.noiseSuppression !== was.noiseSuppression ||
        state.autoGainControl !== was.autoGainControl ||
        state.echoCancellation !== was.echoCancellation
      ) {
        applyProcessingSettings()
      }

      if (state.audioOutputDeviceId !== was.audioOutputDeviceId) {
        applyOutputDevice()
      }
    })
    return unsub
  }, [applyOutputVolumes, armInputMode, applyProcessingSettings, applyOutputDevice])

  return {
    joinVoice,
    leaveVoice,
    toggleMute,
    sendTransportRef,
    recvTransportRef,
    nativeVideoRef,
    videoElRef,
    startDMCall,
    acceptDMCall,
    rejectDMCall,
    endDMCall,
    connectDMCall,
  }
}
