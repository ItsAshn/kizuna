import type { types as mediasoupTypes } from 'mediasoup'
import type { Server as IoServer } from 'socket.io'
import { createWorker, getWorker } from './worker'

function rlog(msg: string) {
  console.log(`[mediasoup] ${msg}`)
}
function rerr(msg: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : String(err ?? '')
  console.error(`[mediasoup] ${msg} | ${detail}`)
}

const routers = new Map<string, mediasoupTypes.Router>()

const MEDIA_CODECS: mediasoupTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    parameters: {
      'useinbandfec': 1,
      'minptime': 10,
      'maxaveragebitrate': 256000,
      'maxplaybackrate': 48000,
      'sprop-maxcapturerate': 48000,
      'sprop-stereo': 0,
      'stereo': 0,
      'usedtx': 1,
      'cbr': 0,
    },
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

  rlog(`createRouter | channelId=${channelId}`)
  const router = await w.createRouter({
    mediaCodecs: MEDIA_CODECS,
  })

  routers.set(channelId, router)
  rlog(`createRouter OK | channelId=${channelId} | totalRouters=${routers.size}`)
  return router
}

function getCachedRouter(channelId: string): mediasoupTypes.Router | undefined {
  return routers.get(channelId)
}

export { ensureRouter as getOrCreateRouter }

export async function ensureRouter(channelId: string): Promise<mediasoupTypes.Router> {
  const existing = routers.get(channelId)
  if (existing) {
    rlog(`ensureRouter cached | channelId=${channelId}`)
    return existing
  }
  return createRouter(channelId)
}

export async function createTransport(router: mediasoupTypes.Router): Promise<mediasoupTypes.WebRtcTransport> {
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0'
  const announcedIp = process.env.PUBLIC_ADDRESS || undefined

  rlog(`createTransport | listenIp=${listenIp} | announcedIp=${announcedIp ?? 'none'} | enableUdp=true | enableTcp=true`)
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: listenIp, announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 5000000,
  })

  rlog(`createTransport OK | transportId=${transport.id} | iceCandidates=${transport.iceCandidates?.length ?? 0}`)
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
    rlog(`consumeOnTransport | socketId=${socketId} | producerId=${producerId} | kind=${kind}`)
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: router.rtpCapabilities,
      paused: kind === 'video',
      appData: {},
    })

    rlog(`consumeOnTransport OK | consumerId=${consumer.id} | kind=${consumer.kind} | type=${consumer.type} | producerPaused=${consumer.producerPaused}`)
    io.to(socketId).emit('voice:newConsumer', {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused,
    })

    consumer.on('producerclose', () => {
      rlog(`producerclose | consumerId=${consumer.id} | producerId=${producerId}`)
      io.to(socketId).emit('voice:consumerClosed', { consumerId: consumer.id })
    })

    return consumer
  } catch (err: any) {
    rerr(`consumeOnTransport failed | producerId=${producerId} | kind=${kind}`, err)
    return null
  }
}

export function closeRouter(channelId: string): void {
  const router = routers.get(channelId)
  if (router) {
    rlog(`closeRouter | channelId=${channelId}`)
    router.close()
    routers.delete(channelId)
  }
}
