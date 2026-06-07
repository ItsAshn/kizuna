import { useRef, useCallback, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { Device } from 'mediasoup-client'
import type { Transport, Producer, Consumer } from 'mediasoup-client/types'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import type { ConnectionQuality } from '@kizuna/shared'

const REMOTE_SPEAKING_THRESHOLD = 15

function thresholdToRms(value: number): number {
  return Math.max(1, Math.round(50 * Math.exp(-value * 0.04)))
}

const SPEAKING_POLL_MS = 80
const SPEAKING_HOLD_MS = 600
const QUALITY_POLL_MS = 3000
const RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_ATTEMPTS = 5
const PCM_BUFFER_MAX_CHUNKS = 100
const SCRIPT_PROCESSOR_BUFFER_SIZE = 480
const AUDIO_SAMPLE_RATE = 48000

let __voiceSeq = 0
const MAX_VOICE_LOG_LINES = 30
const __voiceLogBuffer: string[] = []
function voiceLog(level: 'log'|'err', tag: string, msg: string, extra?: string) {
  const seq = ++__voiceSeq
  const ts = new Date().toISOString().split('T')[1].slice(0, 12)
  const line = `[${ts}] ${tag}: ${msg}${extra ?? ''}`
  __voiceLogBuffer.push(line)
  if (__voiceLogBuffer.length > MAX_VOICE_LOG_LINES) __voiceLogBuffer.shift()
  if (level === 'err') console.error(`[VOICE ${seq}] ${line}`)
  else console.log(`[VOICE ${seq}] ${line}`)
}
export function getVoiceLogLines(): string[] { return [...__voiceLogBuffer] }
function vlog(tag: string, msg: string, data?: unknown) {
  const extra = data !== undefined ? ` ${JSON.stringify(data).slice(0, 200)}` : ''
  voiceLog('log', tag, msg, extra)
}
function verr(tag: string, msg: string, err?: unknown) {
  const detail = err instanceof Error ? `${err.message} (${err.name})` : String(err ?? '')
  voiceLog('err', tag, msg, ` | ${detail}`)
}

interface AudioDataPayload {
  samples_f32: number[]
  sample_rate: number
  channels: number
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

function computeQualityFromStats(report: RTCStatsReport): ConnectionQuality {
  let rttMs = 0
  let jitterMs = 0
  let lossRate = 0
  report.forEach((stat: any) => {
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.currentRoundTripTime != null) {
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
  thresholdRef: { current: number },
  onLevel?: (level: number) => void,
  gainNode?: GainNode,
  audioCtx?: AudioContext,
): () => void {
  const analyserStream = stream.clone()
  const ctx = audioCtx ?? new AudioContext()
  const source = ctx.createMediaStreamSource(analyserStream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.1
  if (gainNode) {
    source.disconnect()
    source.connect(gainNode)
    gainNode.connect(analyser)
  } else {
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
      ctx.resume().then(() => { timer = setTimeout(poll, SPEAKING_POLL_MS) }).catch(() => { timer = setTimeout(poll, 200) })
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
    const threshold = thresholdRef.current
    const nowSpeaking = rms > threshold
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
    if (!audioCtx) ctx.close()
    analyserStream.getTracks().forEach((t) => t.stop())
  }
}

function startNativeSpeakingDetection(
  pcmRingBuffer: Float32Array[],
  onSpeaking: (speaking: boolean) => void,
  thresholdRef: { current: number },
  onLevel?: (level: number) => void,
): () => void {
  let speaking = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  const poll = () => {
    if (stopped) return

    const combinedLength = pcmRingBuffer.reduce((s, c) => s + c.length, 0)
    if (combinedLength === 0) {
      timer = setTimeout(poll, SPEAKING_POLL_MS)
      return
    }

    let squareSum = 0
    let sampleCount = 0
    for (const chunk of pcmRingBuffer) {
      for (let i = 0; i < chunk.length; i++) {
        squareSum += chunk[i] * chunk[i]
        sampleCount++
      }
    }
    const rms = Math.sqrt(squareSum / sampleCount)
    onLevel?.(rms)

    const threshold = thresholdRef.current
    const nowSpeaking = rms > threshold
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

  timer = setTimeout(poll, SPEAKING_POLL_MS)

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    if (holdTimer !== null) clearTimeout(holdTimer)
  }
}

function startRemoteSpeakingDetection(
  track: MediaStreamTrack,
  onSpeaking: (speaking: boolean) => void,
  sharedCtx?: AudioContext,
): () => void {
  const ownsCtx = !sharedCtx
  const ctx = sharedCtx ?? new AudioContext()
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
      ctx.resume().then(() => { timer = setTimeout(poll, SPEAKING_POLL_MS) }).catch(() => { timer = setTimeout(poll, 200) })
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
  const videoConsumerRef = useRef<Consumer | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const channelIdRef = useRef<string | null>(null)
  const localSpeakingCleanupRef = useRef<(() => void) | null>(null)
  const remoteSpeakingCleanupsRef = useRef<Map<string, () => void>>(new Map())
  const qualityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const peerQualityIntervalsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const reconnectAttemptsRef = useRef(0)
  const isReconnectingRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const remoteAudioCtxRef = useRef<AudioContext | null>(null)
  const gainNodeRef = useRef<GainNode | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const pttCleanupRef = useRef<(() => void) | null>(null)
  const thresholdRef = useRef<number>(8)
  const pttPressedRef = useRef<boolean>(false)
  const nativeAudioUnlistenRef = useRef<(() => void) | null>(null)
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null)
  const pcmRingBufferRef = useRef<Float32Array[]>([])
  const serverBitrateRef = useRef<number>(64)
  const iceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const {
    setActiveVoiceChannel,
    setVoicePeers, addVoicePeer, removeVoicePeer, updateVoicePeer,
    isMuted, setIsMuted, setIsSpeaking,
    setLocalConnectionQuality,
    serverVoiceBitrateKbps, setServerVoiceBitrateKbps,
    audioInputDeviceId, audioOutputDeviceId,
    setAudioInputDeviceId,
    setVoiceError,
    setScreenSharePeer, clearScreenSharePeer,
    voiceInputMode, voiceGateThreshold,
    pushToTalkKey,
    noiseSuppression, echoCancellation, autoGainControl,
    inputVolume, outputVolume,
    setLiveAudioLevel,
  } = useChatStore()

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

    nativeAudioUnlistenRef.current?.()
    nativeAudioUnlistenRef.current = null
    nativeVoiceUnlistenRef.current?.()
    nativeVoiceUnlistenRef.current = null
    nativeRemoteAudioUnlistenRef.current?.()
    nativeRemoteAudioUnlistenRef.current = null

    if (isTauri()) {
      vlog('cleanup', 'stopping native audio capture')
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('stop_audio_capture').then(() => vlog('cleanup', 'stop_audio_capture OK')).catch((e) => verr('cleanup', 'stop_audio_capture failed', e))
      )
    }

    scriptNodeRef.current?.disconnect()
    scriptNodeRef.current = null
    pcmRingBufferRef.current = []

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
    sendTransportRef.current?.close()
    recvTransportRef.current?.close()
    sendTransportRef.current = null
    recvTransportRef.current = null
    deviceRef.current = null
    gainNodeRef.current = null
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
  }, [setVoicePeers, setIsSpeaking, setLocalConnectionQuality, setLiveAudioLevel, clearScreenSharePeer])

  const consumePeer = useCallback(async (
    socket: Socket,
    device: Device,
    recvTransport: Transport,
    peerId: string,
    channelId: string,
    remoteCtx: AudioContext,
  ) => {
    vlog('consume', `consuming peer peerId=${peerId}`)
    const params: any = await new Promise((resolve) =>
      socket.emit('voice:consume', { channelId, peerId, rtpCapabilities: device.rtpCapabilities }, resolve),
    )
    if (!params?.id) {
      verr('consume', `no id returned for peer ${peerId}`, params)
      return
    }
    const consumer = await recvTransport.consume(params)
    consumersRef.current.set(peerId, consumer)
    vlog('consume', `consumer created | id=${consumer.id} | kind=${consumer.kind} | paused=${consumer.paused}`)

    await new Promise<void>((resolve) =>
      socket.emit('voice:resumeConsumer', { channelId, consumerId: consumer.id }, () => resolve()),
    )
    await consumer.resume()
    vlog('consume', `consumer resumed | id=${consumer.id}`)

    const audioEl = new Audio()
    audioEl.autoplay = true
    audioEl.srcObject = new MediaStream([consumer.track])
    audioEl.volume = outputVolume / 100
    vlog('consume', `audio element created | srcObject set | volume=${audioEl.volume}`)
    if (audioOutputDeviceId) {
      try {
        await (audioEl as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(audioOutputDeviceId)
        vlog('consume', `sinkId set to ${audioOutputDeviceId}`)
      } catch (e) {
        vlog('consume', `setSinkId failed or unsupported: ${String(e)}`)
      }
    }
    const playResult = await audioEl.play().then(() => 'ok').catch((e) => `error: ${e?.name ?? String(e)}`)
    vlog('consume', `audio.play() -> ${playResult}`)
    audioElemsRef.current.set(peerId, audioEl)

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
      } catch {
        /* ignore */
      }
    }
    pollPeerQuality()
    const peerQInt = setInterval(pollPeerQuality, QUALITY_POLL_MS)
    peerQualityIntervalsRef.current.set(peerId, peerQInt)
  }, [audioOutputDeviceId, updateVoicePeer])

  const consumeScreenShare = useCallback(async (
    socket: Socket,
    device: Device,
    recvTransport: Transport,
    sharerPeerId: string,
    channelId: string,
    username: string,
  ) => {
    try {
      const params: any = await new Promise((resolve) =>
        socket.emit('voice:consume', {
          channelId,
          peerId: sharerPeerId,
          kind: 'video',
          rtpCapabilities: device.rtpCapabilities,
        }, resolve),
      )
      if (!params?.id) {
        console.warn('Failed to consume screen share from', sharerPeerId)
        return
      }

      const consumer = await recvTransport.consume(params)
      videoConsumerRef.current = consumer

      await new Promise<void>((resolve) =>
        socket.emit('voice:resumeConsumer', { channelId, consumerId: consumer.id }, () => resolve()),
      )
      await consumer.resume()

      const videoEl = document.createElement('video')
      videoEl.autoplay = true
      videoEl.playsInline = true
      videoEl.muted = true
      videoEl.srcObject = new MediaStream([consumer.track])
      videoEl.style.width = '100%'
      videoEl.style.height = '100%'
      await videoEl.play().catch(() => {})
      videoElRef.current = videoEl

      setScreenSharePeer(sharerPeerId, username)
    } catch (err) {
      console.error('Failed to consume screen share:', err)
    }
  }, [setScreenSharePeer])

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

    const nativeVoiceUnlistenRef = useRef<(() => void) | null>(null)
  const nativeRemoteAudioUnlistenRef = useRef<(() => void) | null>(null)
  const nativeSpeakingUnlistenRef = useRef<(() => void) | null>(null)
  const nativeAudioCtxRef = useRef<AudioContext | null>(null)
  const nativeAudioNextTimeRef = useRef<number>(0)
  const nativeInitializedRef = useRef(false)
  const nativePeerHandlersRef = useRef<boolean>(false)

  const initNativeVoice = useCallback(async () => {
    if (nativeInitializedRef.current) return
    if (!session) return
    vlog('voice_init', `connecting to ${session.url} as ${session.user.username}`)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('voice_init', {
        serverUrl: session.url,
        authToken: session.token,
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
    nativeRemoteAudioUnlistenRef.current?.()
    nativeSpeakingUnlistenRef.current?.()
    return import('@tauri-apps/api/event').then(({ listen }) =>
      Promise.all([
        listen<any>('voice:event', (event) => {
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
                id: ev.data.peer_id,
                userId: ev.data.user_id,
                username: ev.data.username,
                speaking: false,
                muted: false,
              })
              break
            }
            case 'PeerLeft': {
              removeVoicePeer(ev.data.peer_id)
              break
            }
            case 'PeerSpeaking': {
              updateVoicePeer(ev.data.peer_id, { speaking: ev.data.speaking })
              break
            }
            case 'ScreenShareStarted': {
              setScreenSharePeer(ev.data.peer_id, ev.data.username)
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
        listen<any>('voice:remote_audio', (event) => {
          const { samples, sampleRate } = event.payload
          if (!samples || samples.length === 0) return

          const ctx = nativeAudioCtxRef.current
          if (!ctx || ctx.sampleRate !== (sampleRate || 48000)) {
            nativeAudioCtxRef.current?.close()
            nativeAudioCtxRef.current = new AudioContext({ sampleRate: sampleRate || 48000 })
            nativeAudioNextTimeRef.current = 0
          }

          const audioCtx = nativeAudioCtxRef.current!
          const sampleCount = samples.length
          const buffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate)
          buffer.copyToChannel(new Float32Array(samples), 0)

          const source = audioCtx.createBufferSource()
          source.buffer = buffer
          source.connect(audioCtx.destination)

          let startTime = nativeAudioNextTimeRef.current
          const now = audioCtx.currentTime
          if (startTime < now) {
            startTime = now
          }
          source.start(startTime)

          nativeAudioNextTimeRef.current = startTime + sampleCount / audioCtx.sampleRate
        }).then((unlisten) => {
          nativeRemoteAudioUnlistenRef.current = unlisten
        }),
        listen<any>('voice:speaking', (event) => {
          const { channelId, speaking } = event.payload
          const socket = socketRef.current
          if (socket && channelId) {
            socket.emit('voice:speaking', { channelId, speaking })
          }
          setIsSpeaking(speaking)
        }).then((unlisten) => {
          nativeSpeakingUnlistenRef.current = unlisten
        }),
      ]).then(() => undefined),
    ).catch((e) => {
      verr('setupNativeVoice', 'Failed to setup voice listeners', e)
    })
  }, [addVoicePeer, removeVoicePeer, updateVoicePeer, setActiveVoiceChannel, setVoiceError,
      setScreenSharePeer, clearScreenSharePeer, setIsSpeaking, socketRef])

  const joinVoiceNative = useCallback(async (channelId: string): Promise<string | null> => {
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
      socket.on('voice:newPeer', async (peer: { peerId: string; userId: string; username: string }) => {
        vlog('nativePeer', `voice:newPeer peerId=${peer.peerId}`)
        addVoicePeer({ id: peer.peerId, userId: peer.userId, username: peer.username, speaking: false, muted: false })
        try {
          const consumeResult: any = await new Promise((resolve) =>
            socket!.emit('voice:consume', {
              channelId: channelIdRef.current,
              peerId: peer.peerId,
              rtpCapabilities: { codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }], headerExtensions: [] },
            }, resolve),
          )
          if (consumeResult?.error) {
            verr('nativePeer', `consume ${peer.peerId} failed: ${consumeResult.error}`)
          } else {
            const { invoke: inv } = await import('@tauri-apps/api/core')
            await inv('voice_add_peer', { peerId: peer.peerId })
          }
        } catch (e) {
          verr('nativePeer', `consume ${peer.peerId} error`, e)
        }
      })
      socket.on('voice:peerLeft', ({ peerId }: { peerId: string }) => {
        removeVoicePeer(peerId)
      })
      socket.on('voice:peerSpeaking', ({ peerId, speaking }: { peerId: string; speaking: boolean }) => {
        updateVoicePeer(peerId, { speaking })
      })
    }

    try {
      // Step 1: voice:join via chat socket
      vlog('joinVoiceNative', 'sending voice:join via chat socket')
      const joinResult: any = await new Promise((resolve) =>
        socket!.emit('voice:join', { channelId, userId: session.user.id, username: session.user.username }, resolve),
      )
      if (joinResult?.error) {
        throw new Error(`voice:join failed: ${joinResult.error}`)
      }
      vlog('joinVoiceNative', 'voice:join OK', { peers: joinResult?.peers?.length, bitrate: joinResult?.voiceBitrateKbps })

      setActiveVoiceChannel(channelId)

      const iceServers = joinResult.iceServers || []
      const voiceBitrateKbps = joinResult.voiceBitrateKbps || 64

      // Step 2: create send transport via chat socket
      const sendParams: any = await new Promise((resolve) =>
        socket!.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
      )
      if (sendParams?.error) throw new Error(`send transport create: ${sendParams.error}`)
      vlog('joinVoiceNative', 'send transport created', { id: sendParams?.id })

      // Step 3: create recv transport via chat socket
      const recvParams: any = await new Promise((resolve) =>
        socket!.emit('voice:createTransport', { channelId, direction: 'recv' }, resolve),
      )
      if (recvParams?.error) throw new Error(`recv transport create: ${recvParams.error}`)
      vlog('joinVoiceNative', 'recv transport created', { id: recvParams?.id })

      // Step 4: create WebRTC transports in Rust
      vlog('joinVoiceNative', 'calling voice_begin')
      const [sendDtls, recvDtls, rtpParams] = await invoke('voice_begin', {
        channelId,
        iceServers,
        sendParams,
        recvParams,
        voiceBitrateKbps,
      }) as [any, any, any]
      vlog('joinVoiceNative', 'voice_begin OK', { ssrc: rtpParams?.ssrc })

      // Step 5: connect send transport
      const sendConnectResult: any = await new Promise((resolve) =>
        socket!.emit('voice:connectTransport', {
          channelId,
          transportId: sendParams.id,
          dtlsParameters: sendDtls,
        }, resolve),
      )
      if (sendConnectResult?.error) throw new Error(`send connectTransport: ${sendConnectResult.error}`)
      vlog('joinVoiceNative', 'send connectTransport OK')

      // Step 6: connect recv transport
      const recvConnectResult: any = await new Promise((resolve) =>
        socket!.emit('voice:connectTransport', {
          channelId,
          transportId: recvParams.id,
          dtlsParameters: recvDtls,
        }, resolve),
      )
      if (recvConnectResult?.error) throw new Error(`recv connectTransport: ${recvConnectResult.error}`)
      vlog('joinVoiceNative', 'recv connectTransport OK')

      // Step 7: produce
      const produceResult: any = await new Promise((resolve) =>
        socket!.emit('voice:produce', {
          channelId,
          transportId: sendParams.id,
          kind: 'audio',
          rtpParameters: rtpParams,
        }, resolve),
      )
      if (produceResult?.error) throw new Error(`produce: ${produceResult.error}`)
      vlog('joinVoiceNative', 'produce OK', { producerId: produceResult?.id })

      // Step 8: start audio capture in Rust
      await invoke('voice_finish_join', { voiceBitrateKbps })
      vlog('joinVoiceNative', 'finish_join OK')

      // Step 9: consume existing peers
      if (joinResult.peers) {
        for (const peer of joinResult.peers) {
          const consumeResult: any = await new Promise((resolve) =>
            socket!.emit('voice:consume', {
              channelId,
              peerId: peer.id,
              rtpCapabilities: joinResult.routerRtpCapabilities,
            }, resolve),
          )
          if (consumeResult?.error) {
            verr('joinVoiceNative', `consume peer ${peer.id} failed: ${consumeResult.error}`)
          } else {
            await invoke('voice_add_peer', { peerId: peer.id })
            vlog('joinVoiceNative', `consumed peer ${peer.id}`)
          }
        }
      }

      return null
    } catch (e: any) {
      const err = e?.toString?.() || 'Failed to join voice'
      verr('joinVoiceNative', 'failed', e)
      setVoiceError(err)
      socket?.emit('voice:leave', { channelId })
      try { await invoke('voice_leave') } catch {}
      channelIdRef.current = null
      return err
    }
  }, [socketRef, session, cleanupVoice, setVoiceError, initNativeVoice, setupNativeVoiceListeners, setActiveVoiceChannel])

  const leaveVoiceNative = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('voice_leave')
    } catch (e) {
      verr('leaveVoice', 'Native leave failed', e)
    }
    // Clean up chat socket peer handlers
    const socket = socketRef.current
    if (socket && nativePeerHandlersRef.current) {
      socket.off('voice:newPeer')
      socket.off('voice:peerLeft')
      socket.off('voice:peerSpeaking')
      nativePeerHandlersRef.current = false
    }
    nativeVoiceUnlistenRef.current?.()
    nativeVoiceUnlistenRef.current = null
    nativeRemoteAudioUnlistenRef.current?.()
    nativeRemoteAudioUnlistenRef.current = null
    nativeSpeakingUnlistenRef.current?.()
    nativeSpeakingUnlistenRef.current = null
    nativeAudioCtxRef.current?.close()
    nativeAudioCtxRef.current = null
    channelIdRef.current = null
    setVoicePeers([])
    setIsSpeaking(false)
    setLocalConnectionQuality(null)
    setLiveAudioLevel(0)
    clearScreenSharePeer()
  }, [setVoicePeers, setIsSpeaking, setLocalConnectionQuality, setLiveAudioLevel, clearScreenSharePeer, socketRef])

  const toggleMuteNative = useCallback(async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const newMuted = !isMuted
      await invoke('voice_set_muted', { muted: newMuted })
      setIsMuted(newMuted)
    } catch (e) {
      verr('toggleMute', 'Native mute toggle failed', e)
    }
  }, [isMuted, setIsMuted])

  const joinVoice = useCallback(async (channelId: string): Promise<string | null> => {
    vlog('joinVoice', `starting | channelId=${channelId} | isTauri=${isTauri()} | socket=${!!socketRef.current} | session=${!!session}`)

    if (isTauri()) {
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
    const joinResult: any = await new Promise((resolve) =>
      socket.emit('voice:join', {
        channelId,
        userId: session.user.id,
        username: session.user.username,
      }, resolve),
    )

    if (joinResult?.error) {
      verr('joinVoice', 'voice:join error', joinResult.error)
      setVoiceError(joinResult.error)
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

    if (typeof RTCPeerConnection === 'undefined') {
      verr('joinVoice', 'RTCPeerConnection undefined - WebRTC not supported')
      const err = 'WebRTC is not supported in this browser. On Linux, ensure webkit2gtk is built with WebRTC support, or use Chromium/Firefox via pnpm dev:desktop.'
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
    } catch (loadErr: any) {
      verr('joinVoice', 'mediasoup Device.load() failed', loadErr)
      const err = `WebRTC codec/device initialization failed: ${loadErr?.message || loadErr}. On Linux, ensure webkit2gtk is built with full WebRTC support and required audio codecs (opus) are available.`
      setVoiceError(err)
      cleanupVoice()
      socket.emit('voice:leave', { channelId })
      channelIdRef.current = null
      return err
    }
    vlog('joinVoice', 'Device loaded successfully')
    deviceRef.current = device

    const iceServers = joinResult.iceServers || []

    vlog('joinVoice', 'creating send transport')
    const sendParams: any = await new Promise((resolve) =>
      socket.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
    )
    if (sendParams?.error) {
      verr('joinVoice', 'send transport create failed', sendParams.error)
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
    })
    sendTransportRef.current = sendTransport

    sendTransport.on('connect', ({ dtlsParameters }, cb) => {
      vlog('transport', 'send connect event')
      socket.emit('voice:connectTransport', { channelId, transportId: sendTransport.id, dtlsParameters }, cb)
    })
    sendTransport.on('produce', ({ kind, rtpParameters }, cb) => {
      vlog('transport', `send produce event kind=${kind}`)
      socket.emit('voice:produce', { channelId, transportId: sendTransport.id, kind, rtpParameters }, cb)
    })

    sendTransport.on('connectionstatechange', (state) => {
      vlog('transport', `send connectionstatechange -> ${state}`)
      if (state === 'failed' || state === 'closed') {
        verr('transport', `send transport state: ${state}`)
        handleTransportFailure(socket, channelId)
      }
      if (state === 'connected') {
        if (iceTimerRef.current) { clearTimeout(iceTimerRef.current); iceTimerRef.current = null }
      }
    })

    vlog('joinVoice', 'creating recv transport')
    const recvParams: any = await new Promise((resolve) =>
      socket.emit('voice:createTransport', { channelId, direction: 'recv' }, resolve),
    )
    if (recvParams?.error) {
      verr('joinVoice', 'recv transport create failed', recvParams.error)
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
    })
    recvTransportRef.current = recvTransport

    recvTransport.on('connect', ({ dtlsParameters }, cb) => {
      vlog('transport', 'recv connect event')
      socket.emit('voice:connectTransport', { channelId, transportId: recvTransport.id, dtlsParameters }, cb)
    })

    recvTransport.on('connectionstatechange', (state) => {
      vlog('transport', `recv connectionstatechange -> ${state}`)
      if (state === 'failed' || state === 'closed') {
        verr('transport', `recv transport state: ${state}`)
        handleTransportFailure(socket, channelId)
      }
      if (state === 'connected') {
        if (iceTimerRef.current) { clearTimeout(iceTimerRef.current); iceTimerRef.current = null }
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

    socket.on('voice:newPeer', async (peer: { peerId: string; userId: string; username: string }) => {
      vlog('peer', `voice:newPeer peerId=${peer.peerId} userId=${peer.userId}`)
      await consumePeer(socket, device, recvTransport, peer.peerId, channelId, remoteAudioCtxRef.current!)
      addVoicePeer({
        id: peer.peerId,
        userId: peer.userId,
        username: peer.username,
        speaking: false,
        muted: false,
      })
    })

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
      remoteSpeakingCleanupsRef.current.get(peerId)?.()
      remoteSpeakingCleanupsRef.current.delete(peerId)
      const peerQInt = peerQualityIntervalsRef.current.get(peerId)
      if (peerQInt != null) clearInterval(peerQInt)
      peerQualityIntervalsRef.current.delete(peerId)
      removeVoicePeer(peerId)
    })

    socket.on('voice:peerSpeaking', ({ peerId, speaking }: { peerId: string; speaking: boolean }) => {
      updateVoicePeer(peerId, { speaking })
    })

    socket.on('screen:peerStarted', async (data: { peerId: string; userId: string; username: string }) => {
      await consumeScreenShare(socket, device, recvTransport, data.peerId, channelId, data.username)
    })

    socket.on('screen:peerStopped', () => {
      stopScreenConsume()
    })

    socket.on('voice:consumerClosed', ({ consumerId }: { consumerId: string }) => {
      if (videoConsumerRef.current?.id === consumerId) {
        stopScreenConsume()
      }
    })

    const remoteCtx = new AudioContext()
    remoteAudioCtxRef.current = remoteCtx
    vlog('joinVoice', `remote AudioContext created | state=${remoteCtx.state}`)

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

    const voiceBitrateKbps = joinResult.voiceBitrateKbps ?? 64
    serverBitrateRef.current = voiceBitrateKbps
    setServerVoiceBitrateKbps(voiceBitrateKbps)

    socket.on('server:voiceBitrateChanged', ({ voiceBitrateKbps: newKbps }: { voiceBitrateKbps: number }) => {
      vlog('bitrate', `server:voiceBitrateChanged -> ${newKbps} kbps`)
      serverBitrateRef.current = newKbps
      setServerVoiceBitrateKbps(newKbps)
      if (producerRef.current) {
        producerRef.current.setRtpEncodingParameters({ maxBitrate: newKbps * 1000 }).catch(console.error)
      }
    })

    try {
      if (isTauri()) {
        vlog('mic', 'taking NATIVE microphone path')
        await setupNativeMicrophone(socket, channelId, sendTransport, voiceBitrateKbps)
      } else {
        vlog('mic', 'taking BROWSER microphone path')
        await setupBrowserMicrophone(socket, channelId, sendTransport, voiceBitrateKbps)
      }
      vlog('joinVoice', 'microphone setup complete - voice joined successfully')
    } catch (err: any) {
      verr('joinVoice', `microphone setup FAILED (isTauri=${isTauri()})`, err)
      console.error('Microphone access error', err)
      let errorMsg: string
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMsg = 'Microphone access was denied. Please allow microphone access and try again.'
      } else if (err.name === 'NotFoundError') {
        errorMsg = 'No microphone found. Please connect a microphone and try again.'
      } else if (err.name === 'NotReadableError' || err.name === 'OverconstrainedError' || err.message?.includes('timed out')) {
        errorMsg = 'Microphone is unavailable or in use by another application. On Linux, ensure pipewire-pulse and pipewire-alsa are installed and running.'
      } else {
        const msg = err.message || err.toString?.() || 'Unknown error'
        const linuxHint = navigator.platform?.toLowerCase().includes('linux') || isTauri()
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

    if (qualityIntervalRef.current != null)
      clearInterval(qualityIntervalRef.current)
    const pollLocalQuality = async () => {
      if (!sendTransportRef.current) return
      try {
        const stats = await sendTransportRef.current.getStats()
        setLocalConnectionQuality(computeQualityFromStats(stats))
      } catch {
        // ignore transient errors
      }
    }
    pollLocalQuality()
    qualityIntervalRef.current = setInterval(pollLocalQuality, QUALITY_POLL_MS)

    reconnectAttemptsRef.current = 0
    return null
  }, [
    socketRef, session, cleanupVoice, setActiveVoiceChannel, setVoicePeers,
    addVoicePeer, removeVoicePeer, updateVoicePeer, setIsSpeaking,
    setLocalConnectionQuality, serverVoiceBitrateKbps, setServerVoiceBitrateKbps,
    audioInputDeviceId, audioOutputDeviceId, setVoiceError, consumePeer,
    consumeScreenShare, stopScreenConsume, setScreenSharePeer,
    setLiveAudioLevel, voiceGateThreshold, voiceInputMode,
    pushToTalkKey, noiseSuppression, echoCancellation, autoGainControl,
    inputVolume,
  ])

  const setupBrowserMicrophone = useCallback(async (
    socket: Socket,
    channelId: string,
    sendTransport: Transport,
    bitrateKbps: number,
  ) => {
    vlog('browserMic', `starting | inputDeviceId=${audioInputDeviceId} | inputVolume=${inputVolume} | noiseSupp=${noiseSuppression} | echoCanc=${echoCancellation} | autoGain=${autoGainControl} | bitrate=${bitrateKbps}`)
    const micConstraints: MediaTrackConstraints = audioInputDeviceId
      ? {
          deviceId: { exact: audioInputDeviceId },
          noiseSuppression: { ideal: noiseSuppression },
          echoCancellation: { ideal: echoCancellation },
          autoGainControl: { ideal: autoGainControl },
        }
      : {
          noiseSuppression: { ideal: noiseSuppression },
          echoCancellation: { ideal: echoCancellation },
          autoGainControl: { ideal: autoGainControl },
        }

    vlog('browserMic', 'calling getUserMedia')
    let stream: MediaStream
    try {
      stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: micConstraints }),
        new Promise<MediaStream>((_, reject) =>
          setTimeout(() => reject(new Error('Microphone access timed out')), 5000)
        ),
      ])
    } catch (err: any) {
      if (audioInputDeviceId && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
        vlog('browserMic', `stale device ${audioInputDeviceId}, retrying without device constraint`)
        setAudioInputDeviceId(null)
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: { ideal: noiseSuppression },
              echoCancellation: { ideal: echoCancellation },
              autoGainControl: { ideal: autoGainControl },
            },
          }),
          new Promise<MediaStream>((_, reject) =>
            setTimeout(() => reject(new Error('Microphone access timed out')), 5000)
          ),
        ])
      } else {
        throw err
      }
    }
    vlog('browserMic', `getUserMedia OK | audioTracks=${stream.getAudioTracks().length} | track0=${stream.getAudioTracks()[0]?.label}`)
    micStreamRef.current = stream
    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    vlog('browserMic', `AudioContext created | state=${audioCtx.state} | sampleRate=${audioCtx.sampleRate}`)
    const source = audioCtx.createMediaStreamSource(stream)
    const gainNode = audioCtx.createGain()
    gainNode.gain.value = inputVolume / 100
    gainNodeRef.current = gainNode
    const destination = audioCtx.createMediaStreamDestination()
    source.connect(gainNode)
    gainNode.connect(destination)

    const processedTrack = destination.stream.getAudioTracks()[0]
    vlog('browserMic', `creating producer | trackKind=${processedTrack.kind} | readyState=${processedTrack.readyState}`)
    const producer = await sendTransport.produce({
      track: processedTrack,
      encodings: [{ maxBitrate: bitrateKbps * 1000 }],
      codecOptions: { opusStereo: false, opusDtx: true },
    })
    producerRef.current = producer
    vlog('browserMic', `producer created | id=${producer.id} | kind=${producer.kind} | paused=${producer.paused}`)

    thresholdRef.current = thresholdToRms(voiceGateThreshold)

    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = startSpeakingDetection(
      stream,
      (speaking) => {
        if (voiceInputMode === 'push-to-talk') return
        setIsSpeaking(speaking)
        socket.emit('voice:speaking', { channelId, speaking })
      },
      thresholdRef,
      (level) => setLiveAudioLevel(level),
      gainNode,
      audioCtx,
    )

    if (voiceInputMode === 'push-to-talk') {
      setupPushToTalk(socket, channelId, producer)
    }
  }, [audioInputDeviceId, noiseSuppression, echoCancellation, autoGainControl,
      inputVolume, voiceGateThreshold, voiceInputMode,
      setLiveAudioLevel, setIsSpeaking, pushToTalkKey])

  const setupNativeMicrophone = useCallback(async (
    socket: Socket,
    channelId: string,
    sendTransport: Transport,
    bitrateKbps: number,
  ) => {
    vlog('nativeMic', `starting | inputDeviceId=${audioInputDeviceId} | inputVolume=${inputVolume} | bitrate=${bitrateKbps}`)
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ])
    vlog('nativeMic', 'Tauri API modules imported')

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    vlog('nativeMic', `AudioContext created | state=${audioCtx.state} | sampleRate=${audioCtx.sampleRate}`)

    if (audioCtx.state === 'suspended') {
      vlog('nativeMic', 'AudioContext is suspended - attempting resume')
      try {
        await audioCtx.resume()
        vlog('nativeMic', `AudioContext resumed -> state=${audioCtx.state}`)
      } catch (e) {
        verr('nativeMic', 'AudioContext resume failed', e)
      }
    }

    const scriptNode = audioCtx.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1
    )
    scriptNodeRef.current = scriptNode
    vlog('nativeMic', `ScriptProcessorNode created | bufferSize=${SCRIPT_PROCESSOR_BUFFER_SIZE}`)

    const gainNode = audioCtx.createGain()
    gainNode.gain.value = inputVolume / 100
    gainNodeRef.current = gainNode

    const destination = audioCtx.createMediaStreamDestination()
    scriptNode.connect(gainNode)
    gainNode.connect(destination)
    vlog('nativeMic', 'audio graph: scriptNode -> gainNode -> destination connected')
    vlog('nativeMic', `destination stream tracks=${destination.stream.getAudioTracks().length}`)

    const pcmBuffer: Float32Array[] = []
    let pcmOffset = 0
    pcmRingBufferRef.current = pcmBuffer

    let scriptFired = false
    let scriptFireCount = 0
    scriptNode.onaudioprocess = (e) => {
      if (!scriptFired) {
        scriptFired = true
        vlog('nativeMic', 'onaudioprocess first fire!')
      }
      scriptFireCount++
      if (scriptFireCount % 100 === 0) {
        vlog('nativeMic', `onaudioprocess fired ${scriptFireCount} times | pcmBuffer.length=${pcmBuffer.length} | offset=${pcmOffset}`)
      }
      const output = e.outputBuffer.getChannelData(0)
      const needed = output.length
      let written = 0

      while (written < needed && pcmBuffer.length > 0) {
        const chunk = pcmBuffer[0]
        const remaining = chunk.length - pcmOffset
        const toCopy = Math.min(needed - written, remaining)
        output.set(chunk.subarray(pcmOffset, pcmOffset + toCopy), written)
        written += toCopy
        pcmOffset += toCopy
        if (pcmOffset >= chunk.length) {
          pcmBuffer.shift()
          pcmOffset = 0
        }
      }

      if (written < needed) {
        output.fill(0, written)
      }
    }

    let audioDataCount = 0
    let audioDataFirstTs = 0
    const unlisten = await listen<AudioDataPayload>('audio:data', (event) => {
      audioDataCount++
      if (audioDataCount === 1) {
        audioDataFirstTs = Date.now()
        vlog('nativeMic', `first audio:data received | sampleRate=${event.payload.sample_rate} | channels=${event.payload.channels} | bufferLen=${event.payload.samples_f32.length}`)
      } else if (audioDataCount % 200 === 0) {
        const elapsed = (Date.now() - audioDataFirstTs) / 1000
        const rate = audioDataCount / elapsed
        vlog('nativeMic', `audio:data #${audioDataCount} | rate=${rate.toFixed(1)}/s | bufferLen=${event.payload.samples_f32.length} | buffer queue=${pcmBuffer.length}`)
      }
      const samples = new Float32Array(event.payload.samples_f32)
      pcmBuffer.push(samples)
      while (pcmBuffer.length > PCM_BUFFER_MAX_CHUNKS) {
        pcmBuffer.shift()
        if (pcmOffset > 0) pcmOffset = 0
      }
    })
    nativeAudioUnlistenRef.current = unlisten
    vlog('nativeMic', 'audio:data listener registered')

    vlog('nativeMic', `invoking start_audio_capture | deviceId=${audioInputDeviceId} | sampleRate=${AUDIO_SAMPLE_RATE} | channels=1`)
    try {
      await invoke('start_audio_capture', {
        deviceName: audioInputDeviceId ?? null,
        sampleRate: AUDIO_SAMPLE_RATE,
        channels: 1,
      })
      vlog('nativeMic', 'start_audio_capture OK')
    } catch (e) {
      if (audioInputDeviceId) {
        verr('nativeMic', `start_audio_capture failed with device ${audioInputDeviceId}, retrying without device constraint`, e)
        setAudioInputDeviceId(null)
        try {
          await invoke('start_audio_capture', {
            deviceName: null,
            sampleRate: AUDIO_SAMPLE_RATE,
            channels: 1,
          })
          vlog('nativeMic', 'start_audio_capture OK (default device)')
        } catch (e2) {
          verr('nativeMic', 'start_audio_capture failed with default device', e2)
          throw e2
        }
      } else {
        verr('nativeMic', 'start_audio_capture failed', e)
        throw e
      }
    }

    vlog('nativeMic', `creating producer | sampleRate=${AUDIO_SAMPLE_RATE} | bitrate=${bitrateKbps * 1000}`)
    const processedTrack = destination.stream.getAudioTracks()[0]
    vlog('nativeMic', `track info | kind=${processedTrack.kind} | label=${processedTrack.label} | readyState=${processedTrack.readyState} | enabled=${processedTrack.enabled}`)

    const producer = await sendTransport.produce({
      track: processedTrack,
      encodings: [{ maxBitrate: bitrateKbps * 1000 }],
      codecOptions: { opusStereo: false, opusDtx: true },
    })
    producerRef.current = producer
    vlog('nativeMic', `producer created | id=${producer.id} | kind=${producer.kind} | paused=${producer.paused} | closed=${producer.closed}`)

    thresholdRef.current = thresholdToRms(voiceGateThreshold)
    vlog('nativeMic', `starting native speaking detection | gateThreshold=${voiceGateThreshold} | rmsThreshold=${thresholdRef.current} | inputMode=${voiceInputMode}`)

    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = startNativeSpeakingDetection(
      pcmBuffer,
      (speaking) => {
        if (voiceInputMode === 'push-to-talk') return
        setIsSpeaking(speaking)
        socket.emit('voice:speaking', { channelId, speaking })
      },
      thresholdRef,
      (level) => setLiveAudioLevel(level),
    )

    if (voiceInputMode === 'push-to-talk') {
      setupPushToTalk(socket, channelId, producer)
    }
  }, [audioInputDeviceId, inputVolume, voiceGateThreshold,
      voiceInputMode, setLiveAudioLevel, setIsSpeaking, pushToTalkKey])

  const setupPushToTalk = useCallback((
    socket: Socket,
    channelId: string,
    producer: Producer,
  ) => {
    setIsSpeaking(false)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === pushToTalkKey && !e.repeat && producerRef.current) {
        e.preventDefault()
        pttPressedRef.current = true
        producerRef.current.resume()
        setIsSpeaking(true)
        socket.emit('voice:speaking', { channelId, speaking: true })
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === pushToTalkKey && producerRef.current) {
        pttPressedRef.current = false
        producerRef.current.pause()
        setIsSpeaking(false)
        socket.emit('voice:speaking', { channelId, speaking: false })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    producer.pause()
    pttCleanupRef.current = () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [pushToTalkKey, setIsSpeaking])

  const handleTransportFailure = useCallback((socket: Socket, channelId: string) => {
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
  }, [joinVoice, cleanupVoice, setVoiceError])

  const leaveVoice = useCallback(() => {
    if (isTauri()) {
      leaveVoiceNative()
      setActiveVoiceChannel(null)
      setIsMuted(false)
      setVoiceError(null)
      return
    }
    const socket = socketRef.current
    cleanupVoice()
    if (socket) {
      socket.off('voice:newPeer')
      socket.off('voice:peerLeft')
      socket.off('voice:peerSpeaking')
      socket.off('screen:peerStarted')
      socket.off('screen:peerStopped')
      socket.off('voice:consumerClosed')
      stopScreenConsume()
      socket.emit('voice:leave', { channelId: channelIdRef.current })
    }
    channelIdRef.current = null
    setActiveVoiceChannel(null)
    setIsMuted(false)
    setVoiceError(null)
  }, [socketRef, cleanupVoice, setActiveVoiceChannel, setIsMuted, setVoiceError])

  const toggleMute = useCallback(() => {
    if (voiceInputMode === 'push-to-talk') return
    if (isTauri()) {
      toggleMuteNative()
      return
    }
    const muted = !isMuted
    setIsMuted(muted)
    if (producerRef.current) {
      if (muted) producerRef.current.pause()
      else producerRef.current.resume()
    }
  }, [isMuted, setIsMuted, voiceInputMode])

  useEffect(() => {
    let prevInputVolume = inputVolume
    let prevOutputVolume = outputVolume
    let prevThreshold = voiceGateThreshold

    const unsub = useChatStore.subscribe((state) => {
      if (state.inputVolume !== prevInputVolume) {
        prevInputVolume = state.inputVolume
        if (gainNodeRef.current) {
          gainNodeRef.current.gain.value = state.inputVolume / 100
        }
      }
      if (state.outputVolume !== prevOutputVolume) {
        prevOutputVolume = state.outputVolume
        audioElemsRef.current.forEach((el) => {
          el.volume = state.outputVolume / 100
        })
      }
      if (state.voiceGateThreshold !== prevThreshold) {
        prevThreshold = state.voiceGateThreshold
        thresholdRef.current = thresholdToRms(state.voiceGateThreshold)
      }
    })
    return unsub
  }, [])

  return { joinVoice, leaveVoice, toggleMute, sendTransportRef, recvTransportRef, videoElRef }
}
