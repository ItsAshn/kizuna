import type { types as mediasoupTypes } from 'mediasoup'
import type { Server as IoServer } from 'socket.io'
import { createWorker, getWorker } from './worker'

const routers = new Map<string, mediasoupTypes.Router>()

const MEDIA_CODECS: mediasoupTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
    preferredPayloadType: 101,
  },
]

export async function createRouter(channelId: string): Promise<mediasoupTypes.Router> {
  const w = getWorker()
  if (!w) throw new Error('mediasoup worker not initialized')

  const router = await w.createRouter({
    mediaCodecs: MEDIA_CODECS,
  })

  routers.set(channelId, router)
  return router
}

function getCachedRouter(channelId: string): mediasoupTypes.Router | undefined {
  return routers.get(channelId)
}

export { getCachedRouter as getOrCreateRouter }

export async function ensureRouter(channelId: string): Promise<mediasoupTypes.Router> {
  const existing = routers.get(channelId)
  if (existing) return existing
  return createRouter(channelId)
}

export async function createTransport(router: mediasoupTypes.Router): Promise<mediasoupTypes.WebRtcTransport> {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0'
  const announcedIp = process.env.PUBLIC_ADDRESS || undefined

  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: listenIp, announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 5000000,
  })

  return transport
}

export async function connectTransport(
  transport: mediasoupTypes.WebRtcTransport,
  dtlsParameters: mediasoupTypes.DtlsParameters,
): Promise<void> {
  await transport.connect({ dtlsParameters })
}

export async function produceOnTransport(
  transport: mediasoupTypes.WebRtcTransport,
  options: { kind: 'audio' | 'video'; rtpParameters: mediasoupTypes.RtpParameters },
): Promise<mediasoupTypes.Producer> {
  return transport.produce({
    kind: options.kind,
    rtpParameters: options.rtpParameters,
    appData: {},
  })
}

export async function consumeOnTransport(
  router: mediasoupTypes.Router,
  transport: mediasoupTypes.WebRtcTransport,
  producerId: string,
  kind: 'audio' | 'video',
  socketId: string,
  io: IoServer,
): Promise<mediasoupTypes.Consumer | null> {
  try {
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: kind === 'video',
      appData: {},
    })

    io.to(socketId).emit('voice:newConsumer', {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused,
    })

    consumer.on('producerclose', () => {
      io.to(socketId).emit('voice:consumerClosed', { consumerId: consumer.id })
    })

    return consumer
  } catch (err: any) {
    console.error('[mediasoup] consume error:', err.message)
    return null
  }
}

export function closeRouter(channelId: string): void {
  const router = routers.get(channelId)
  if (router) {
    router.close()
    routers.delete(channelId)
  }
}
