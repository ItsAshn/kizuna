import { useRef, useCallback, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import type { Transport, Producer } from 'mediasoup-client/types'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'
import { useNotificationStore } from '../store/notificationStore'
import { isTauri, isMobileTauri, isLinuxDesktop } from '../utils/platform'
import type { NativeVideoProducer } from './useVoice'
import { getWebviewVideoSend } from './webviewVideoSend'
import { nativeFrames, LOCAL_CAMERA_STREAM_ID } from './videoReceiver'

const CAMERA_WIDTH = 640
const CAMERA_HEIGHT = 480
const CAMERA_FPS = 24
/** Matches CAMERA_MAX_BITRATE_BPS on the native side. */
const VIDEO_MAX_BITRATE = 600_000

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

function notifyCameraError(message: string) {
  useNotificationStore.getState().addNotification({
    type: 'message',
    title: 'Camera Error',
    body: message,
  })
}

/**
 * Local camera.
 *
 *   Linux desktop  — Rust captures, VP8-encodes and sends on the call's camera
 *                    track (the webview has no WebRTC). A reduced-rate JPEG
 *                    preview still comes to the page for the self-view.
 *   Windows/macOS  — Rust captures and JPEG-encodes, the page paints a canvas
 *                    and sends its stream on the shared webview video
 *                    transport.
 *   Browser/mobile — getUserMedia on the call's own send transport.
 */
export function useCamera(
  socketRef: React.MutableRefObject<Socket | null>,
  sendTransportRef: React.MutableRefObject<Transport | null>,
  nativeVideoRef: React.MutableRefObject<NativeVideoProducer | null>,
) {
  const cameraProducerRef = useRef<Producer | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)
  const errorUnlistenRef = useRef<(() => void) | null>(null)
  // Whether the camera is on, whichever path is sending it.
  const activeRef = useRef(false)
  const nativeActiveRef = useRef(false)

  const callStore = useCallStore

  const cleanupLocal = useCallback(async () => {
    activeRef.current = false
    cameraProducerRef.current?.close()
    cameraProducerRef.current = null
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null

    unlistenRef.current?.()
    unlistenRef.current = null
    errorUnlistenRef.current?.()
    errorUnlistenRef.current = null
    nativeFrames.forget(LOCAL_CAMERA_STREAM_ID)

    if (canvasRef.current) {
      canvasRef.current.remove()
      canvasRef.current = null
    }

    if (isTauri() && !isMobileTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        if (nativeActiveRef.current) {
          nativeActiveRef.current = false
          // The server closed the producer on camera:stopped; the next start
          // produces the track again.
          if (nativeVideoRef.current) nativeVideoRef.current.camera.producerId = null
          await invoke('voice_camera_stop')
        } else {
          await invoke('camera_stop')
        }
      } catch {
        // camera may not be active
      }
    }

    callStore.getState().setIsCameraOn(false)
    callStore.getState().setLocalCameraVideoProducerId(null)
  }, [nativeVideoRef])

  /**
   * Paint `camera:frame` JPEGs from Rust onto a hidden canvas. Returns the
   * canvas's stream when the webview can capture one (always on
   * Windows/macOS; WebKitGTK may not), which is both the self-view and, on
   * Windows/macOS, what gets sent.
   */
  const startJpegCanvas = useCallback(async (): Promise<MediaStream | null> => {
    const canvas = document.createElement('canvas')
    canvas.width = CAMERA_WIDTH
    canvas.height = CAMERA_HEIGHT
    canvas.style.display = 'none'
    document.body.appendChild(canvas)
    canvasRef.current = canvas

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to get canvas context')

    const { listen } = await import('@tauri-apps/api/event')
    unlistenRef.current = await listen<CameraFramePayload>('camera:frame', (event) => {
      const { jpeg_base64, width, height } = event.payload
      try {
        const bytes = base64ToUint8(jpeg_base64)
        const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' })
        createImageBitmap(blob)
          .then((bitmap) => {
            if (canvas.width !== width) canvas.width = width
            if (canvas.height !== height) canvas.height = height
            ctx.drawImage(bitmap, 0, 0)
            bitmap.close()
          })
          .catch(() => {})
      } catch {
        // skip malformed frames
      }
    })

    if (typeof canvas.captureStream !== 'function') return null
    return canvas.captureStream(CAMERA_FPS)
  }, [])

  /**
   * Linux self-view. WebKitGTK delivers no frames from canvas.captureStream(),
   * so the preview JPEGs are painted the way received native video is: through
   * the native frame dispatcher, under LOCAL_CAMERA_STREAM_ID.
   */
  const startNativeSelfView = useCallback(async () => {
    const { listen } = await import('@tauri-apps/api/event')
    unlistenRef.current = await listen<CameraFramePayload>('camera:frame', (event) => {
      try {
        nativeFrames.dispatchJpeg(LOCAL_CAMERA_STREAM_ID, base64ToUint8(event.payload.jpeg_base64))
      } catch {
        // skip malformed frames
      }
    })
  }, [])

  const startCamera = useCallback(
    async (channelId: string) => {
      const socket = socketRef.current
      try {
        if (!socket) throw new Error('No socket connection')

        if (isTauri() && !isMobileTauri()) {
          const { listen } = await import('@tauri-apps/api/event')
          // Opening the device can fail after start returns (unplugged,
          // taken by another app); Rust reports it rather than going quiet.
          errorUnlistenRef.current = await listen<{ message: string }>('camera:error', (e) => {
            // While starting, the failed start call reports the same error.
            if (!activeRef.current) return
            notifyCameraError(e.payload.message)
            socket.emit('camera:stopped', { channelId })
            cleanupLocal()
          })
        }

        if (isLinuxDesktop()) {
          const native = nativeVideoRef.current
          if (!native) throw new Error('Voice not joined — join a voice channel first')
          const { invoke } = await import('@tauri-apps/api/core')

          // Self-view only; the video itself never touches the webview.
          await startNativeSelfView()

          if (!native.camera.producerId) {
            const res: { id?: string; error?: string } = await new Promise((resolve) =>
              socket.emit(
                'voice:produce',
                {
                  channelId,
                  transportId: native.transportId,
                  kind: 'video',
                  rtpParameters: native.camera.rtpParameters,
                  source: 'camera',
                },
                resolve,
              ),
            )
            if (!res?.id) throw new Error(`Camera produce failed: ${res?.error ?? 'no producer'}`)
            native.camera.producerId = res.id
          }
          nativeActiveRef.current = true
          await invoke('voice_camera_start', {
            cameraIndex: 0,
            width: CAMERA_WIDTH,
            height: CAMERA_HEIGHT,
            fps: CAMERA_FPS,
          })

          activeRef.current = true
          callStore.getState().setIsCameraOn(true)
          callStore.getState().setLocalCameraVideoProducerId(native.camera.producerId)
          socket.emit('camera:started', { channelId, producerId: native.camera.producerId })
          return
        }

        if (isTauri() && !isMobileTauri()) {
          const sendTransport = await getWebviewVideoSend(socket, channelId)
          const stream = await startJpegCanvas()
          if (!stream) throw new Error('This webview cannot capture a canvas stream')
          cameraStreamRef.current = stream
          const videoTrack = stream.getVideoTracks()[0]
          if (!videoTrack) throw new Error('No video track from canvas stream')

          const { invoke } = await import('@tauri-apps/api/core')
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
            appData: { source: 'camera' },
          })

          cameraProducerRef.current = producer
          activeRef.current = true
          callStore.getState().setIsCameraOn(true)
          callStore.getState().setLocalCameraVideoProducerId(producer.id)

          socket.emit('camera:started', { channelId, producerId: producer.id })
          return
        }

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
          appData: { source: 'camera' },
        })

        cameraProducerRef.current = producer
        activeRef.current = true
        callStore.getState().setIsCameraOn(true)
        callStore.getState().setLocalCameraVideoProducerId(producer.id)

        socket.emit('camera:started', { channelId, producerId: producer.id })
      } catch (err) {
        console.error('Failed to start camera:', err)
        notifyCameraError(
          `Failed to start camera: ${err instanceof Error ? err.message : String(err)}`,
        )
        // Release whatever was produced so it does not linger on the server.
        socket?.emit('camera:stopped', { channelId })
        await cleanupLocal()
      }
    },
    [
      socketRef,
      sendTransportRef,
      nativeVideoRef,
      cleanupLocal,
      startJpegCanvas,
      startNativeSelfView,
    ],
  )

  const stopCamera = useCallback(
    async (channelId: string) => {
      const socket = socketRef.current
      if (socket) {
        // The server closes the producer, which tells every viewer.
        socket.emit('camera:stopped', { channelId })
      }
      await cleanupLocal()
    },
    [socketRef, cleanupLocal],
  )

  const toggleCamera = useCallback(
    async (channelId: string) => {
      if (activeRef.current) {
        await stopCamera(channelId)
      } else {
        await startCamera(channelId)
      }
    },
    [startCamera, stopCamera],
  )

  const getStream = useCallback(() => cameraStreamRef.current, [])

  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId)

  useEffect(() => {
    if (!activeVoiceChannelId && activeRef.current) {
      stopCamera(activeVoiceChannelId ?? '')
    }
  }, [activeVoiceChannelId, stopCamera])

  return { startCamera, stopCamera, toggleCamera, getStream, cameraStreamRef }
}
