import { useRef, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import type { Transport, Producer, Device } from 'mediasoup-client/types'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'
import { isTauri, isLinuxDesktop } from '../utils/platform'
import type { NativeVideoProducer } from './useVoice'

interface ScreenFramePayload {
  jpeg_base64: string
  width: number
  height: number
}

export function useScreenshare(
  socketRef: React.MutableRefObject<Socket | null>,
  sendTransportRef: React.MutableRefObject<Transport | null>,
  nativeVideoRef: React.MutableRefObject<NativeVideoProducer | null>,
) {
  const videoProducerRef = useRef<Producer | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)
  const localTransportRef = useRef(false)
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
    // Native path: the encoder and capture session both live in Rust, and the
    // video producer is kept alive for reuse on the next share.
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false
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
  }, [])

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
        // The video track lives for the whole call, so it only needs producing
        // once: re-sharing reuses the same producer rather than leaking a new one
        // on the server every time.
        if (!native.producerId) {
          const produceResult: { id?: string; error?: string } = await new Promise((resolve) =>
            socket.emit(
              'voice:produce',
              {
                channelId,
                transportId: native.transportId,
                kind: 'video',
                rtpParameters: native.rtpParameters,
                source: 'screen',
              },
              resolve,
            ),
          )
          if (produceResult?.error) return `Video produce failed: ${produceResult.error}`
          native.producerId = produceResult?.id ?? null
        }

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
        await invoke('voice_screen_share_stop').catch(() => {})
        const e = err as { message?: string; toString?: () => string }
        return e?.message || e?.toString?.() || 'Failed to start screenshare'
      }
    },
    [socketRef, nativeVideoRef],
  )

  const startScreenshare = useCallback(
    async (channelId: string, monitorIndex: number, fps: number = 15): Promise<string | null> => {
      const socket = socketRef.current
      let sendTransport = sendTransportRef.current

      if (!socket) return 'No socket connection'
      if (!isTauri()) return 'Screensharing only works in the Tauri desktop app'

      if (isLinuxDesktop()) {
        return startNativeScreenshare(channelId, monitorIndex, fps)
      }

      if (typeof RTCPeerConnection === 'undefined')
        return 'WebRTC is not supported in this webview. On Linux, ensure webkit2gtk is built with WebRTC support.'

      if (!sendTransport) {
        try {
          const rtpCapabilities = voiceStore.getState().routerRtpCapabilities
          if (!rtpCapabilities)
            return 'Voice connection not established. Join a voice channel first.'

          const { Device: DeviceClass } = await import('mediasoup-client')
          const device = new DeviceClass() as Device
          await device.load({ routerRtpCapabilities: rtpCapabilities })

          const sendParams: Record<string, unknown> = await new Promise((resolve) =>
            socket.emit('voice:createTransport', { channelId, direction: 'send' }, resolve),
          )
          if (sendParams?.error) return `Transport creation failed: ${sendParams.error}`

          sendTransport = device.createSendTransport({
            ...sendParams,
            iceServers: [],
          } as unknown as Parameters<typeof device.createSendTransport>[0]) as Transport

          sendTransport.on('connect', ({ dtlsParameters }, cb) => {
            socket.emit(
              'voice:connectTransport',
              { channelId, transportId: sendTransport!.id, dtlsParameters },
              cb,
            )
          })
          sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb) => {
            socket.emit(
              'voice:produce',
              {
                channelId,
                transportId: sendTransport!.id,
                kind,
                rtpParameters,
                source: (appData as { source?: 'camera' | 'screen' })?.source,
              },
              cb,
            )
          })

          sendTransportRef.current = sendTransport
          localTransportRef.current = true
        } catch (err: unknown) {
          const e = err as { message?: string }
          return `Failed to initialize video transport: ${e?.message || err}`
        }
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
                canvas.width = width
                canvas.height = height
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

        await invoke('start_screen_capture', { monitorIndex, fps })

        const producer = await sendTransport.produce({
          track,
          encodings: [{ maxBitrate: 2_500_000 }],
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
              reject(new Error(result.error))
            } else {
              resolve()
            }
          })
        })

        callStore.getState().setIsScreenSharing(true)
        return null
      } catch (err: unknown) {
        cleanupLocal()
        if (localTransportRef.current) {
          sendTransportRef.current?.close()
          sendTransportRef.current = null
          localTransportRef.current = false
        }
        const e = err as { message?: string; toString?: () => string }
        return e?.message || e?.toString?.() || 'Failed to start screenshare'
      }
    },
    [socketRef, sendTransportRef, cleanupLocal, startNativeScreenshare],
  )

  const stopScreenshare = useCallback(() => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('screen:stop', { channelId: voiceStore.getState().activeVoiceChannelId })
    }
    cleanupLocal()
  }, [socketRef, cleanupLocal])

  return { startScreenshare, stopScreenshare, videoProducerRef }
}
