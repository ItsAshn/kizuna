import { useRef, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import type { Transport, Producer } from 'mediasoup-client/types'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'
import { useNotificationStore } from '../store/notificationStore'
import { isTauri, isLinuxDesktop } from '../utils/platform'
import type { NativeVideoProducer } from './useVoice'
import { getWebviewVideoSend } from './webviewVideoSend'

interface ScreenFramePayload {
  jpeg_base64: string
  width: number
  height: number
}

function notifyScreenshareError(message: string) {
  useNotificationStore.getState().addNotification({
    type: 'message',
    title: 'Screen Share Error',
    body: message,
  })
}

/** Matches SCREEN_SHARE_MAX_BITRATE_BPS on the native side. */
const SCREEN_MAX_BITRATE = 4_000_000

export function useScreenshare(
  socketRef: React.MutableRefObject<Socket | null>,
  sendTransportRef: React.MutableRefObject<Transport | null>,
  nativeVideoRef: React.MutableRefObject<NativeVideoProducer | null>,
) {
  const videoProducerRef = useRef<Producer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)
  const errorUnlistenRef = useRef<(() => void) | null>(null)
  const nativeActiveRef = useRef(false)

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
    errorUnlistenRef.current?.()
    errorUnlistenRef.current = null

    // Native path: the encoder and capture session both live in Rust. The
    // video track stays on the send transport for the whole call, but the
    // server closes its producer on `screen:stop`, so the next share has to
    // produce it again.
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false
      if (nativeVideoRef.current) nativeVideoRef.current.screen.producerId = null
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('voice_screen_share_stop').catch(() => {}),
      )
      callStore.getState().setIsScreenSharing(false)
      return
    }

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
        invoke('stop_screen_capture').catch(() => {}),
      )
    }

    callStore.getState().setIsScreenSharing(false)
    callStore.getState().setScreenShareVideoProducerId(null)
  }, [nativeVideoRef])

  /**
   * Rust reports a capture it cannot recover (portal stream lost, DXGI gone,
   * repeated X11 errors) as `screen:error`. End the share, so viewers are not
   * left on "Waiting for video…" and the sharer is not shown as still sharing.
   * Registered before capture starts, so an early failure is not missed.
   */
  const listenForCaptureError = useCallback(
    async (channelId: string) => {
      const { listen } = await import('@tauri-apps/api/event')
      errorUnlistenRef.current?.()
      errorUnlistenRef.current = await listen<{ message: string }>('screen:error', (e) => {
        notifyScreenshareError(e.payload.message)
        socketRef.current?.emit('screen:stop', { channelId })
        cleanupLocal()
      })
    },
    [socketRef, cleanupLocal],
  )

  /**
   * Linux path: the WebKitGTK webview has no WebRTC stack, so Rust captures,
   * VP8-encodes and sends the frames on the video track the native voice
   * transport already carries. The webview only drives signalling.
   */
  const startNativeScreenshare = useCallback(
    async (channelId: string, monitorIndex: number, fps: number): Promise<string | null> => {
      const socket = socketRef.current!
      const native = nativeVideoRef.current
      if (!native) return 'Voice connection not established. Join a voice channel first.'

      const { invoke } = await import('@tauri-apps/api/core')

      try {
        // The track lives for the whole call; its server producer is created
        // per share (the server closes it on screen:stop).
        if (!native.screen.producerId) {
          const produceResult: { id?: string; error?: string } = await new Promise((resolve) =>
            socket.emit(
              'voice:produce',
              {
                channelId,
                transportId: native.transportId,
                kind: 'video',
                rtpParameters: native.screen.rtpParameters,
                source: 'screen',
              },
              resolve,
            ),
          )
          if (produceResult?.error) return `Video produce failed: ${produceResult.error}`
          native.screen.producerId = produceResult?.id ?? null
        }

        await listenForCaptureError(channelId)

        // Bitrate is left to Rust so the encoder and the RTP parameters already
        // announced to the server cannot disagree.
        await invoke('voice_screen_share_start', { monitorIndex, fps })

        await new Promise<void>((resolve, reject) => {
          socket.emit('screen:start', { channelId }, (result: { error?: string } | undefined) => {
            if (result?.error) reject(new Error(result.error))
            else resolve()
          })
        })

        nativeActiveRef.current = true
        callStore.getState().setIsScreenSharing(true)
        return null
      } catch (err: unknown) {
        errorUnlistenRef.current?.()
        errorUnlistenRef.current = null
        await invoke('voice_screen_share_stop').catch(() => {})
        // Release the producer so the next attempt (or someone else) can share.
        socket.emit('screen:stop', { channelId })
        native.screen.producerId = null
        const e = err as { message?: string; toString?: () => string }
        return e?.message || e?.toString?.() || 'Failed to start screenshare'
      }
    },
    [socketRef, nativeVideoRef, listenForCaptureError],
  )

  const startScreenshare = useCallback(
    async (channelId: string, monitorIndex: number, fps: number = 15): Promise<string | null> => {
      const socket = socketRef.current

      if (!socket) return 'No socket connection'
      if (!isTauri()) return 'Screensharing only works in the Tauri desktop app'

      if (isLinuxDesktop()) {
        return startNativeScreenshare(channelId, monitorIndex, fps)
      }

      if (typeof RTCPeerConnection === 'undefined')
        return 'WebRTC is not supported in this webview, so the screen cannot be sent from it.'

      // Windows/macOS: Rust captures and JPEG-encodes frames, the webview
      // paints them on a canvas and sends the canvas stream. It goes on the
      // call's own send transport when there is one (browser path), otherwise
      // on the shared webview video transport.
      let sendTransport: Transport
      try {
        sendTransport = sendTransportRef.current ?? (await getWebviewVideoSend(socket, channelId))
      } catch (err: unknown) {
        const e = err as { message?: string }
        return `Failed to initialize video transport: ${e?.message || err}`
      }

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
            createImageBitmap(blob)
              .then((bitmap) => {
                if (canvas.width !== width) canvas.width = width
                if (canvas.height !== height) canvas.height = height
                ctx.drawImage(bitmap, 0, 0)
                bitmap.close()
              })
              .catch(() => {})
          } catch {
            /* skip malformed frames */
          }
        })
        unlistenRef.current = unlisten

        const stream = canvas.captureStream(fps)
        streamRef.current = stream
        const track = stream.getVideoTracks()[0]

        await listenForCaptureError(channelId)
        await invoke('start_screen_capture', { monitorIndex, fps })

        const producer = await sendTransport.produce({
          track,
          encodings: [{ maxBitrate: SCREEN_MAX_BITRATE }],
          codecOptions: {
            videoGoogleStartBitrate: 1000,
          },
          appData: { source: 'screen' },
        })
        videoProducerRef.current = producer

        await new Promise<void>((resolve, reject) => {
          socket.emit('screen:start', { channelId }, (result: { error?: string } | undefined) => {
            if (result?.error) {
              producer.close()
              videoProducerRef.current = null
              socket.emit('screen:stop', { channelId })
              reject(new Error(result.error))
            } else {
              resolve()
            }
          })
        })

        callStore.getState().setIsScreenSharing(true)
        callStore.getState().setScreenShareVideoProducerId(producer.id)
        return null
      } catch (err: unknown) {
        cleanupLocal()
        const e = err as { message?: string; toString?: () => string }
        return e?.message || e?.toString?.() || 'Failed to start screenshare'
      }
    },
    [socketRef, sendTransportRef, cleanupLocal, startNativeScreenshare, listenForCaptureError],
  )

  const stopScreenshare = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      // The server closes the producer, which tells every viewer, and frees
      // the "one share at a time" slot for someone else.
      socket.emit('screen:stop', { channelId: voiceStore.getState().activeVoiceChannelId })
    }
    cleanupLocal()
  }, [socketRef, cleanupLocal])

  return { startScreenshare, stopScreenshare, videoProducerRef }
}
