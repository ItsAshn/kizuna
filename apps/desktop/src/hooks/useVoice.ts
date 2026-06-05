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

  const {
    setActiveVoiceChannel,
    setVoicePeers, addVoicePeer, removeVoicePeer, updateVoicePeer,
    isMuted, setIsMuted, setIsSpeaking,
    setLocalConnectionQuality,
    audioBitrateKbps, setAudioBitrateKbps,
    audioInputDeviceId, audioOutputDeviceId,
    setVoiceError,
    setScreenSharePeer, clearScreenSharePeer,
    voiceInputMode, voiceGateThreshold,
    pushToTalkKey,
    noiseSuppression, echoCancellation, autoGainControl,
    inputVolume, outputVolume,
    setLiveAudioLevel,
  } = useChatStore()

  const cleanupVoice = useCallback(() => {
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

    if (isTauri()) {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('stop_audio_capture').catch(() => {})
      )
    }

    scriptNodeRef.current?.disconnect()
    scriptNodeRef.current = null
    pcmRingBufferRef.current = []

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
    const params: any = await new Promise((resolve) =>
      socket.emit('voice:consume', { channelId, peerId, rtpCapabilities: device.rtpCapabilities }, resolve),
    )
    if (!params?.id) {
      console.warn('voice:consume returned no id for peer', peerId, params)
      return
    }
    const consumer = await recvTransport.consume(params)
    consumersRef.current.set(peerId, consumer)

    await new Promise<void>((resolve) =>
      socket.emit('voice:resumeConsumer', { channelId, consumerId: consumer.id }, () => resolve()),
    )
    await consumer.resume()

    const audioEl = new Audio()
    audioEl.autoplay = true
    audioEl.srcObject = new MediaStream([consumer.track])
    audioEl.volume = outputVolume / 100
    if (audioOutputDeviceId) {
      try {
        await (audioEl as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(audioOutputDeviceId)
      } catch {
        /* setSinkId not supported or device unavailable */
      }
    }
    await audioEl.play().catch(() => {
      /* autoplay policy */
    })
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

  const joinVoice = useCallback(async (channelId: string): Promise<string | null> => {
    const socket = socketRef.current
    if (!socket || !session) return 'No socket connection'

    cleanupVoice()
    channelIdRef.current = channelId
    setVoiceError(null)

    const joinResult: any = await new Promise((resolve) =>
      socket.emit('voice:join', {
        channelId,
        userId: session.user.id,
        username: session.user.username,
      }, resolve),
    )

    if (joinResult?.error) {
      console.error('voice:join failed', joinResult.error)
      return joinResult.error
    }
    if (!joinResult?.routerRtpCapabilities) {
      console.error('voice:join failed', joinResult)
      return 'Failed to join voice channel'
    }

    if (typeof RTCPeerConnection === 'undefined') {
      return 'WebRTC is not supported in this browser. On Linux, ensure webkit2gtk is built with WebRTC support, or use Chromium/Firefox via pnpm dev:desktop.'
    }

    const device = new Device()
    await device.load({ routerRtpCapabilities: joinResult.routerRtpCapabilities })
    deviceRef.current = device

    const iceServers = joinResult.iceServers || []

    const sendParams: any = await new Promise((resolve) =>
      socket.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
    )
    if (sendParams?.error) return `Send transport failed: ${sendParams.error}`

    const sendTransport = device.createSendTransport({
      ...sendParams,
      iceServers: iceServers.length > 0 ? iceServers : undefined,
    })
    sendTransportRef.current = sendTransport

    sendTransport.on('connect', ({ dtlsParameters }, cb) => {
      socket.emit('voice:connectTransport', { channelId, transportId: sendTransport.id, dtlsParameters }, cb)
    })
    sendTransport.on('produce', ({ kind, rtpParameters }, cb) => {
      socket.emit('voice:produce', { channelId, transportId: sendTransport.id, kind, rtpParameters }, cb)
    })

    sendTransport.on('connectionstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        console.error('Send transport connection state:', state)
        handleTransportFailure(socket, channelId)
      }
    })

    const recvParams: any = await new Promise((resolve) =>
      socket.emit('voice:createTransport', { channelId, direction: 'recv' }, resolve),
    )
    if (recvParams?.error) return `Recv transport failed: ${recvParams.error}`

    const recvTransport = device.createRecvTransport({
      ...recvParams,
      iceServers: iceServers.length > 0 ? iceServers : undefined,
    })
    recvTransportRef.current = recvTransport

    recvTransport.on('connect', ({ dtlsParameters }, cb) => {
      socket.emit('voice:connectTransport', { channelId, transportId: recvTransport.id, dtlsParameters }, cb)
    })

    recvTransport.on('connectionstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        console.error('Recv transport connection state:', state)
        handleTransportFailure(socket, channelId)
      }
    })

    socket.on('voice:newPeer', async (peer: { peerId: string; userId: string; username: string }) => {
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

    setActiveVoiceChannel(channelId)

    const remoteCtx = new AudioContext()
    remoteAudioCtxRef.current = remoteCtx

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

    try {
      if (isTauri()) {
        await setupNativeMicrophone(socket, channelId, sendTransport)
      } else {
        await setupBrowserMicrophone(socket, channelId, sendTransport)
      }
    } catch (err: any) {
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
    setLocalConnectionQuality, audioBitrateKbps, audioInputDeviceId,
    audioOutputDeviceId, setVoiceError, consumePeer,
    consumeScreenShare, stopScreenConsume, setScreenSharePeer,
    setLiveAudioLevel, voiceGateThreshold, voiceInputMode,
    pushToTalkKey, noiseSuppression, echoCancellation, autoGainControl,
    inputVolume,
  ])

  const setupBrowserMicrophone = useCallback(async (
    socket: Socket,
    channelId: string,
    sendTransport: Transport,
  ) => {
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

    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: micConstraints }),
      new Promise<MediaStream>((_, reject) =>
        setTimeout(() => reject(new Error('Microphone access timed out')), 5000)
      ),
    ])
    micStreamRef.current = stream
    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx
    const source = audioCtx.createMediaStreamSource(stream)
    const gainNode = audioCtx.createGain()
    gainNode.gain.value = inputVolume / 100
    gainNodeRef.current = gainNode
    const destination = audioCtx.createMediaStreamDestination()
    source.connect(gainNode)
    gainNode.connect(destination)

    const processedTrack = destination.stream.getAudioTracks()[0]
    const producer = await sendTransport.produce({
      track: processedTrack,
      encodings: [{ maxBitrate: audioBitrateKbps * 1000 }],
      codecOptions: { opusStereo: false, opusDtx: true },
    })
    producerRef.current = producer

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
      inputVolume, audioBitrateKbps, voiceGateThreshold, voiceInputMode,
      setLiveAudioLevel, setIsSpeaking, pushToTalkKey])

  const setupNativeMicrophone = useCallback(async (
    socket: Socket,
    channelId: string,
    sendTransport: Transport,
  ) => {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ])

    const audioCtx = new AudioContext()
    audioCtxRef.current = audioCtx

    const scriptNode = audioCtx.createScriptProcessor(
      SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1
    )
    scriptNodeRef.current = scriptNode

    const gainNode = audioCtx.createGain()
    gainNode.gain.value = inputVolume / 100
    gainNodeRef.current = gainNode

    const destination = audioCtx.createMediaStreamDestination()
    scriptNode.connect(gainNode)
    gainNode.connect(destination)

    const pcmBuffer: Float32Array[] = []
    let pcmOffset = 0
    pcmRingBufferRef.current = pcmBuffer

    scriptNode.onaudioprocess = (e) => {
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

    const unlisten = await listen<AudioDataPayload>('audio:data', (event) => {
      const samples = new Float32Array(event.payload.samples_f32)
      pcmBuffer.push(samples)
      while (pcmBuffer.length > PCM_BUFFER_MAX_CHUNKS) {
        pcmBuffer.shift()
        if (pcmOffset > 0) pcmOffset = 0
      }
    })
    nativeAudioUnlistenRef.current = unlisten

    await invoke('start_audio_capture', {
      deviceName: audioInputDeviceId ?? null,
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: 1,
    })

    const processedTrack = destination.stream.getAudioTracks()[0]
    const producer = await sendTransport.produce({
      track: processedTrack,
      encodings: [{ maxBitrate: audioBitrateKbps * 1000 }],
      codecOptions: { opusStereo: false, opusDtx: true },
    })
    producerRef.current = producer

    thresholdRef.current = thresholdToRms(voiceGateThreshold)

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
  }, [audioInputDeviceId, inputVolume, audioBitrateKbps, voiceGateThreshold,
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
    const muted = !isMuted
    setIsMuted(muted)
    if (producerRef.current) {
      if (muted) producerRef.current.pause()
      else producerRef.current.resume()
    }
  }, [isMuted, setIsMuted, voiceInputMode])

  const setAudioBitrate = useCallback((socket: Socket, kbps: number) => {
    setAudioBitrateKbps(kbps)
    const bps = kbps * 1000

    if (producerRef.current) {
      producerRef.current.setRtpEncodingParameters({ maxBitrate: bps }).catch(console.error)
    }

    if (socket && sendTransportRef.current) {
      socket.emit('voice:setBitrate', {
        channelId: channelIdRef.current,
        transportId: sendTransportRef.current.id,
        maxBitrateKbps: kbps,
      })
    }
  }, [setAudioBitrateKbps])

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

  return { joinVoice, leaveVoice, toggleMute, setAudioBitrate, sendTransportRef, recvTransportRef, videoElRef }
}
