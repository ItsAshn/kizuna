import { useRef, useCallback, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { Device } from 'mediasoup-client'
import type { Transport, Producer } from 'mediasoup-client/types'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'
import { isTauri } from '../utils/platform'

const CAMERA_WIDTH = 640
const CAMERA_HEIGHT = 480
const CAMERA_FPS = 24
const VIDEO_MAX_BITRATE = 300_000

interface CameraFramePayload {
  jpeg_base64: string
  width: number
  height: number
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function useCamera(
  socketRef: React.MutableRefObject<Socket | null>,
  sendTransportRef: React.MutableRefObject<Transport | null>,
) {
  const cameraProducerRef = useRef<Producer | null>(null)
  const cameraTransportRef = useRef<Transport | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)
  const deviceRef = useRef<Device | null>(null)

  const callStore = useCallStore
  const voiceStore = useVoiceStore

  const cleanupLocal = useCallback(async () => {
    cameraProducerRef.current?.close()
    cameraProducerRef.current = null
    cameraTransportRef.current?.close()
    cameraTransportRef.current = null
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null

    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }

    if (canvasRef.current) {
      canvasRef.current.remove()
      canvasRef.current = null
    }

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('camera_stop')
      } catch {
        // camera may not be active
      }
    }

    deviceRef.current = null
    callStore.getState().setIsCameraOn(false)
    callStore.getState().setLocalCameraVideoProducerId(null)
  }, [])

  const startCamera = useCallback(async (channelId: string) => {
    try {
      const socket = socketRef.current
      if (!socket) throw new Error('No socket connection')

      if (isTauri()) {
        const rtpCapabilities = voiceStore.getState().routerRtpCapabilities
        if (!rtpCapabilities) throw new Error('Voice not joined — join a voice channel first')

        const device = new Device()
        await device.load({ routerRtpCapabilities: rtpCapabilities })
        deviceRef.current = device

        const sendParams: Record<string, unknown> = await new Promise((resolve) =>
          socket.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
        )
        if (sendParams?.error) throw new Error(`Create transport failed: ${sendParams.error}`)

        const sendTransport = device.createSendTransport(sendParams as Parameters<typeof device.createSendTransport>[0])
        cameraTransportRef.current = sendTransport

        sendTransport.on('connect', ({ dtlsParameters }, cb) => {
          socket.emit('voice:connectTransport', {
            channelId,
            transportId: sendTransport.id,
            dtlsParameters,
          }, cb)
        })

        sendTransport.on('produce', ({ kind, rtpParameters }, cb) => {
          socket.emit('voice:produce', {
            channelId,
            transportId: sendTransport.id,
            kind,
            rtpParameters,
          }, cb)
        })

        const canvas = document.createElement('canvas')
        canvas.width = CAMERA_WIDTH
        canvas.height = CAMERA_HEIGHT
        canvas.style.display = 'none'
        document.body.appendChild(canvas)
        canvasRef.current = canvas

        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Failed to get canvas context')

        const [{ listen }] = await Promise.all([
          import('@tauri-apps/api/event'),
        ])

        const unlisten = await listen<CameraFramePayload>('camera:frame', (event) => {
          const { jpeg_base64, width, height } = event.payload
          try {
            const bytes = base64ToUint8(jpeg_base64)
            const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' })
            createImageBitmap(blob).then((bitmap) => {
              canvas.width = width
              canvas.height = height
              ctx.drawImage(bitmap, 0, 0)
              bitmap.close()
            }).catch(() => {})
          } catch {
            // skip malformed frames
          }
        })
        unlistenRef.current = unlisten

        const stream = canvas.captureStream(CAMERA_FPS)
        cameraStreamRef.current = stream
        const videoTrack = stream.getVideoTracks()[0]
        if (!videoTrack) throw new Error('No video track from canvas stream')

        const [{ invoke }] = await Promise.all([
          import('@tauri-apps/api/core'),
        ])

        await invoke('camera_start', {
          cameraIndex: 0,
          width: CAMERA_WIDTH,
          height: CAMERA_HEIGHT,
          fps: CAMERA_FPS,
        })

        const producer = await sendTransport.produce({
          track: videoTrack,
          encodings: [{ maxBitrate: VIDEO_MAX_BITRATE }],
          codecOptions: {
            videoGoogleStartBitrate: 300,
          },
        })

        cameraProducerRef.current = producer
        callStore.getState().setIsCameraOn(true)
        callStore.getState().setLocalCameraVideoProducerId(producer.id)

        socket.emit('camera:started', { channelId, producerId: producer.id })
      } else {
        const sendTransport = sendTransportRef.current
        if (!sendTransport) throw new Error('Send transport not ready')

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: CAMERA_WIDTH },
            height: { ideal: CAMERA_HEIGHT },
            frameRate: { ideal: CAMERA_FPS },
          },
        })
        cameraStreamRef.current = stream

        const videoTrack = stream.getVideoTracks()[0]
        if (!videoTrack) throw new Error('No video track')

        const producer = await sendTransport.produce({
          track: videoTrack,
          encodings: [{ maxBitrate: VIDEO_MAX_BITRATE }],
          codecOptions: {
            videoGoogleStartBitrate: 300,
          },
        })

        cameraProducerRef.current = producer
        callStore.getState().setIsCameraOn(true)
        callStore.getState().setLocalCameraVideoProducerId(producer.id)

        socket.emit('camera:started', { channelId, producerId: producer.id })
      }
    } catch (err) {
      console.error('Failed to start camera:', err)
      await cleanupLocal()
    }
  }, [socketRef, sendTransportRef, cleanupLocal])

  const stopCamera = useCallback(async (channelId: string) => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('camera:stopped', { channelId })
    }
    await cleanupLocal()
  }, [cleanupLocal])

  const toggleCamera = useCallback(async (channelId: string) => {
    if (cameraProducerRef.current) {
      await stopCamera(channelId)
    } else {
      await startCamera(channelId)
    }
  }, [startCamera, stopCamera])

  const getStream = useCallback(() => cameraStreamRef.current, [])

  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId)

  useEffect(() => {
    if (!activeVoiceChannelId && cameraProducerRef.current) {
      stopCamera(activeVoiceChannelId ?? '')
    }
  }, [activeVoiceChannelId, stopCamera])

  return { startCamera, stopCamera, toggleCamera, getStream, cameraStreamRef }
}
