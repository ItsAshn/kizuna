import type { Socket } from 'socket.io-client'
import type { Consumer, Device, RtpCapabilities, Transport } from 'mediasoup-client/types'
import type { PeerVideo } from '../store/voiceStore'

/**
 * Receiving remote screenshare and camera video.
 *
 * Audio is native on every desktop OS; video has two receive paths, chosen by
 * what the webview can do:
 *
 *   webview — mediasoup-client in the page, on a video-only recv transport.
 *             Windows and macOS, whose webviews have WebRTC, and the browser.
 *   native  — a webrtc-rs recv peer connection in Rust that decodes VP8 with
 *             GStreamer and streams JPEG frames to the page over a Tauri
 *             channel, drawn on a canvas. Linux, where WebKitGTK has no WebRTC.
 *
 * `localStorage['kizuna.videoRecv'] = 'native' | 'webview'` forces a path.
 */

export type { PeerVideo }

/** The parts of a `voice:consume` ack a receiver needs. */
export interface ConsumeAck {
  id: string
  producerId: string
  kind: 'audio' | 'video'
  rtpParameters: {
    codecs?: { mimeType?: string; payloadType?: number; clockRate?: number }[]
    encodings?: { ssrc?: number }[]
    rtcp?: { cname?: string }
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface VideoReceiver {
  readonly kind: 'webview' | 'native'
  /** Server transport id that `voice:consume` must target. */
  readonly transportId: string
  /** What to tell the server we can decode. */
  readonly rtpCapabilities: RtpCapabilities
  /** Start receiving a consumer the server just created. */
  attach(ack: ConsumeAck): Promise<PeerVideo>
  /** Stop receiving one consumer (local side only). */
  detach(consumerId: string): void
  /** Tear the receiver down. Idempotent. */
  close(): void
}

export type VideoReceiverKind = 'webview' | 'native'

/**
 * Which receive path this client uses: an explicit override, else the
 * webview whenever it has WebRTC, else native (Linux).
 */
export function chooseVideoReceiver(): VideoReceiverKind {
  try {
    const forced = localStorage.getItem('kizuna.videoRecv')
    if (forced === 'native' || forced === 'webview') return forced
  } catch {
    /* storage unavailable */
  }
  return typeof RTCPeerConnection !== 'undefined' ? 'webview' : 'native'
}

type Emit = <T>(event: string, payload: Record<string, unknown>) => Promise<T>

function emitter(socket: Socket): Emit {
  return <T>(event: string, payload: Record<string, unknown>) =>
    new Promise<T>((resolve) => socket.emit(event, payload, resolve))
}

/**
 * Wrap a mediasoup-client recv transport. `owned` receivers close the
 * transport with themselves; the browser path's shared audio+video recv
 * transport is not owned.
 */
export function wrapWebviewReceiver(
  device: Device,
  transport: Transport,
  owned: boolean,
): VideoReceiver {
  const consumers = new Map<string, Consumer>()
  let closed = false
  return {
    kind: 'webview',
    transportId: transport.id,
    rtpCapabilities: device.rtpCapabilities,
    async attach(ack) {
      const consumer = await transport.consume(ack as Parameters<Transport['consume']>[0])
      consumers.set(consumer.id, consumer)
      consumer.on('transportclose', () => consumers.delete(consumer.id))
      if (consumer.paused) consumer.resume()
      return { kind: 'stream', stream: new MediaStream([consumer.track]) }
    },
    detach(consumerId) {
      consumers.get(consumerId)?.close()
      consumers.delete(consumerId)
    },
    close() {
      if (closed) return
      closed = true
      consumers.forEach((c) => c.close())
      consumers.clear()
      if (owned && !transport.closed) transport.close()
    },
  }
}

/**
 * Windows/macOS receiver: a mediasoup-client Device with its own video-only
 * recv transport (server purpose `video`). Audio keeps arriving natively.
 */
export async function createWebviewVideoReceiver(opts: {
  socket: Socket
  channelId: string
  routerRtpCapabilities: RtpCapabilities
  iceServers: { urls: string; username?: string; credential?: string }[]
}): Promise<VideoReceiver> {
  const { socket, channelId, routerRtpCapabilities, iceServers } = opts
  const emit = emitter(socket)
  const { Device: DeviceClass } = await import('mediasoup-client')
  const device = new DeviceClass() as Device
  await device.load({ routerRtpCapabilities })

  const params = await emit<Record<string, unknown>>('voice:createTransport', {
    channelId,
    direction: 'recv',
    purpose: 'video',
  })
  if (params?.error) throw new Error(`video recv transport: ${String(params.error)}`)

  const transport = device.createRecvTransport({
    ...params,
    iceServers: iceServers.length > 0 ? iceServers : undefined,
  } as Parameters<Device['createRecvTransport']>[0])
  transport.on('connect', ({ dtlsParameters }, cb, errback) => {
    socket.emit(
      'voice:connectTransport',
      { channelId, transportId: transport.id, dtlsParameters },
      (res: { error?: string } | undefined) => {
        if (res?.error) errback(new Error(res.error))
        else cb()
      },
    )
  })
  return wrapWebviewReceiver(device, transport, true)
}

/**
 * The capabilities the native decoder supports: VP8 only, with the feedback
 * it sends (NACK, PLI, FIR). Video consumers are created against these so
 * the server never hands the native receiver a codec it cannot decode.
 */
export const NATIVE_VIDEO_RTP_CAPABILITIES: RtpCapabilities = {
  codecs: [
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      preferredPayloadType: 101,
      parameters: {},
      rtcpFeedback: [
        { type: 'nack', parameter: '' },
        { type: 'nack', parameter: 'pli' },
        { type: 'ccm', parameter: 'fir' },
      ],
    },
  ],
  headerExtensions: [],
}

/** Size of the header in front of every native frame: u32 streamId, u16 w, u16 h, u32 reserved. */
export const NATIVE_FRAME_HEADER_BYTES = 12

type FrameSink = (bitmap: ImageBitmap) => void

/**
 * Routes decoded native frames to whatever canvases show that stream.
 * Frames for a stream that is still decoding the previous one are dropped:
 * live video wants the newest picture, not a queue.
 */
class NativeFrameDispatcher {
  private sinks = new Map<number, Set<FrameSink>>()
  private busy = new Set<number>()
  private last = new Map<number, ImageBitmap>()

  register(streamId: number, sink: FrameSink): () => void {
    let set = this.sinks.get(streamId)
    if (!set) {
      set = new Set()
      this.sinks.set(streamId, set)
    }
    set.add(sink)
    // A canvas mounted mid-stream (say, the tile moved to the stage) shows
    // the last picture straight away instead of waiting for the next frame.
    const last = this.last.get(streamId)
    if (last) sink(last)
    return () => {
      const s = this.sinks.get(streamId)
      s?.delete(sink)
      if (s && s.size === 0) this.sinks.delete(streamId)
    }
  }

  forget(streamId: number) {
    this.last.get(streamId)?.close()
    this.last.delete(streamId)
    this.busy.delete(streamId)
  }

  dispatch(buf: ArrayBuffer) {
    if (buf.byteLength <= NATIVE_FRAME_HEADER_BYTES) return
    const view = new DataView(buf)
    const streamId = view.getUint32(0, true)
    if (this.busy.has(streamId)) return
    this.busy.add(streamId)
    const jpeg = new Blob([new Uint8Array(buf, NATIVE_FRAME_HEADER_BYTES)], { type: 'image/jpeg' })
    createImageBitmap(jpeg)
      .then((bitmap) => {
        this.last.get(streamId)?.close()
        this.last.set(streamId, bitmap)
        this.sinks.get(streamId)?.forEach((sink) => sink(bitmap))
      })
      .catch(() => {})
      .finally(() => this.busy.delete(streamId))
  }
}

export const nativeFrames = new NativeFrameDispatcher()

/** Paint every native frame of `streamId` onto `canvas`, sized to the frame. */
export function attachNativeCanvas(canvas: HTMLCanvasElement, streamId: number): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  return nativeFrames.register(streamId, (bitmap) => {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height
    ctx.drawImage(bitmap, 0, 0)
  })
}

interface NativeAddResult {
  streamId: number
  /** Present on the first add: the recv transport has to be connected with it. */
  dtls: Record<string, unknown> | null
}

/**
 * Linux receiver: Rust owns the recv peer connection and the decoders; the
 * page only does signalling and painting.
 */
export async function createNativeVideoReceiver(opts: {
  socket: Socket
  channelId: string
  iceServers: { urls: string; username?: string; credential?: string }[]
}): Promise<VideoReceiver> {
  const { socket, channelId, iceServers } = opts
  const emit = emitter(socket)
  const [{ invoke, Channel }] = await Promise.all([import('@tauri-apps/api/core')])

  const params = await emit<Record<string, unknown>>('voice:createTransport', {
    channelId,
    direction: 'recv',
    purpose: 'video',
  })
  if (params?.error) throw new Error(`video recv transport: ${String(params.error)}`)
  const transportId = params.id as string

  const onFrame = new Channel<ArrayBuffer>()
  onFrame.onmessage = (buf) => {
    if (buf instanceof ArrayBuffer) nativeFrames.dispatch(buf)
  }
  await invoke('video_recv_open', { iceServers, transportParams: params, onFrame })

  const streams = new Map<string, number>()
  let closed = false

  return {
    kind: 'native',
    transportId,
    rtpCapabilities: NATIVE_VIDEO_RTP_CAPABILITIES,
    async attach(ack) {
      const codec = ack.rtpParameters.codecs?.[0]
      const ssrc = ack.rtpParameters.encodings?.[0]?.ssrc
      if (!codec?.payloadType || !ssrc) throw new Error('consumer has no VP8 codec or SSRC')
      const res = await invoke<NativeAddResult>('video_recv_add', {
        consumerId: ack.id,
        ssrc,
        payloadType: codec.payloadType,
        cname: ack.rtpParameters.rtcp?.cname ?? '',
      })
      if (res.dtls) {
        const connected = await emit<{ error?: string }>('voice:connectTransport', {
          channelId,
          transportId,
          dtlsParameters: res.dtls,
        })
        if (connected?.error) throw new Error(`video recv connect: ${connected.error}`)
      }
      streams.set(ack.id, res.streamId)
      return { kind: 'native', streamId: res.streamId }
    },
    detach(consumerId) {
      const streamId = streams.get(consumerId)
      streams.delete(consumerId)
      if (streamId !== undefined) nativeFrames.forget(streamId)
      invoke('video_recv_remove', { consumerId }).catch(() => {})
    },
    close() {
      if (closed) return
      closed = true
      streams.forEach((streamId) => nativeFrames.forget(streamId))
      streams.clear()
      invoke('video_recv_close').catch(() => {})
    },
  }
}
