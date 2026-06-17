import { useRef, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import type { Transport, Producer } from 'mediasoup-client/types'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'

interface ScreenFramePayload {
  jpeg_base64: string
  width: number
  height: number
}

function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__
}

export function useScreenshare(
  socketRef: React.MutableRefObject<Socket | null>,
  sendTransportRef: React.MutableRefObject<Transport | null>,
) {
  const videoProducerRef = useRef<Producer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)

  const callStore = useCallStore
  const voiceStore = useVoiceStore

  const base64ToUint8 = (b64: string): Uint8Array => {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  const cleanupLocal = useCallback(() => {
    videoProducerRef.current?.close()
    videoProducerRef.current = null

    if (unlistenRef.current) {
      unlistenRef.current()
      unlistenRef.current = null
    }

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null

    if (canvasRef.current) {
      canvasRef.current.remove()
      canvasRef.current = null
    }

    if (isTauri()) {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('stop_screen_capture').catch(() => {})
      )
    }

    callStore.getState().setIsScreenSharing(false)
    callStore.getState().setScreenShareVideoProducerId(null)
  }, [])

  const startScreenshare = useCallback(async (
    channelId: string,
    monitorIndex: number,
    fps: number = 15,
  ): Promise<string | null> => {
    const socket = socketRef.current
    const sendTransport = sendTransportRef.current
    if (!socket || !sendTransport) return 'No active voice connection'
    if (!isTauri()) return 'Screensharing only works in the Tauri desktop app'

    try {
      const [{ invoke }, { listen }] = await Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/event'),
      ])
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return 'Failed to create canvas context'
      canvas.style.display = 'none'
      document.body.appendChild(canvas)
      canvasRef.current = canvas

      const unlisten = await listen<ScreenFramePayload>('screen:frame', (event) => {
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
          /* skip malformed frames */
        }
      })
      unlistenRef.current = unlisten

      const stream = canvas.captureStream(fps)
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]

      await invoke('start_screen_capture', { monitorIndex, fps })

      const producer = await sendTransport.produce({
        track,
        encodings: [{ maxBitrate: 2_500_000 }],
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
      })
      videoProducerRef.current = producer

      await new Promise<void>((resolve, reject) => {
        socket.emit('screen:start', { channelId }, (result: any) => {
          if (result?.error) {
            producer.close()
            videoProducerRef.current = null
            reject(new Error(result.error))
          } else {
            resolve()
          }
        })
      })

      callStore.getState().setIsScreenSharing(true)
      return null
    } catch (err: any) {
      cleanupLocal()
      return err?.message || err?.toString() || 'Failed to start screenshare'
    }
  }, [socketRef, sendTransportRef, cleanupLocal])

  const stopScreenshare = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('screen:stop', { channelId: voiceStore.getState().activeVoiceChannelId })
    }
    cleanupLocal()
  }, [socketRef, cleanupLocal])

  return { startScreenshare, stopScreenshare, videoProducerRef }
}
