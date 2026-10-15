/**
 * Pure transport/producer bookkeeping for the voice handler, kept free of
 * mediasoup and socket.io so it can be unit tested with plain objects.
 */
import { MAX_INCOMING_BITRATE_BPS, MAX_TRANSPORTS_PER_PEER } from '../constants'

export type TransportDirection = 'send' | 'recv'

/**
 * What a transport carries. A peer holds at most one transport per
 * (direction, purpose):
 *
 *   audio — voice only (the native client's send PC on Windows/macOS, and the
 *           DirectTransport every native client receives audio on)
 *   av    — voice plus video (the browser client's transports, and the native
 *           Linux send PC, which carries screen and camera too)
 *   video — video only (the webview camera/screen send transport on
 *           Windows/macOS, and the video recv transport of native clients)
 */
export type TransportPurpose = 'audio' | 'av' | 'video'

export function isTransportPurpose(v: unknown): v is TransportPurpose {
  return v === 'audio' || v === 'av' || v === 'video'
}

export interface TransportSlot {
  id: string
  direction: TransportDirection
  purpose: TransportPurpose
  closed?: boolean
}

/**
 * The purpose of a transport whose client did not say. Older clients only
 * sent a direction: their first send transport carried the microphone (and,
 * in the browser, camera too), and any later send transport was the extra
 * camera/screen one that replaced its predecessor.
 */
export function defaultPurpose(
  direction: TransportDirection,
  existing: readonly TransportSlot[],
): TransportPurpose {
  if (direction === 'recv') return 'av'
  const hasMainSend = existing.some(
    (t) => !t.closed && t.direction === 'send' && (t.purpose === 'av' || t.purpose === 'audio'),
  )
  return hasMainSend ? 'video' : 'av'
}

/**
 * Decide what has to close so a new transport for `(direction, purpose)` fits:
 * the existing transport in the same slot is replaced (a client re-creates it
 * after a failure or when it restarts camera/screen without telling us), and
 * the total stays under {@link MAX_TRANSPORTS_PER_PEER}.
 */
export function planTransportSlot(
  existing: readonly TransportSlot[],
  direction: TransportDirection,
  purpose: TransportPurpose,
  max: number = MAX_TRANSPORTS_PER_PEER,
): { replace: string[]; error: string | null } {
  const open = existing.filter((t) => !t.closed)
  const replace = open
    .filter((t) => t.direction === direction && t.purpose === purpose)
    .map((t) => t.id)
  if (open.length - replace.length >= max) return { replace: [], error: 'Too many transports' }
  return { replace, error: null }
}

/**
 * Pick the recv transport a consumer goes on. An explicit `transportId` wins
 * (it must be one of this peer's open recv transports). Otherwise video goes
 * on a transport that can carry it — never the audio-only DirectTransport,
 * which is where video consumes used to land — and audio prefers the
 * audio-only one.
 */
export function pickRecvTransport(
  transports: readonly TransportSlot[],
  kind: 'audio' | 'video',
  transportId?: string,
): TransportSlot | null {
  const recv = transports.filter((t) => !t.closed && t.direction === 'recv')
  if (transportId) return recv.find((t) => t.id === transportId) ?? null
  const order: TransportPurpose[] = kind === 'video' ? ['video', 'av'] : ['audio', 'av']
  for (const purpose of order) {
    const hit = recv.find((t) => t.purpose === purpose)
    if (hit) return hit
  }
  return null
}

/** Incoming bitrate cap for a send transport of `purpose`, in bits/s. */
export function maxIncomingBitrateBps(purpose: TransportPurpose, voiceBitrateKbps: number): number {
  const voice = voiceBitrateKbps * 1000
  if (purpose === 'audio') return voice
  // Voice rides on the av transport alongside video, so its budget is added.
  if (purpose === 'av') return MAX_INCOMING_BITRATE_BPS.av + voice
  return MAX_INCOMING_BITRATE_BPS.video
}

export interface ProducerLike {
  id: string
  kind: string
  closed: boolean
  appData?: { source?: unknown }
}

export type VideoSource = 'screen' | 'camera'

/** Screen video is any video producer not tagged as camera (older clients sent no source). */
export function producerSource(p: ProducerLike): VideoSource | null {
  if (p.kind !== 'video') return null
  return p.appData?.source === 'camera' ? 'camera' : 'screen'
}

export function findVideoProducer(
  producers: Iterable<ProducerLike>,
  source: VideoSource,
): ProducerLike | null {
  for (const p of producers) {
    if (!p.closed && producerSource(p) === source) return p
  }
  return null
}

export interface PeerMediaLike {
  socketId: string
  userId: string
  username: string
  producers: Map<string, ProducerLike>
}

/** Who in `peers` is sharing their screen, if anyone. */
export function findScreenSharer(
  peers: Iterable<PeerMediaLike>,
): { peerId: string; userId: string; username: string; producerId: string } | null {
  for (const peer of peers) {
    const p = findVideoProducer(peer.producers.values(), 'screen')
    if (p) {
      return {
        peerId: peer.socketId,
        userId: peer.userId,
        username: peer.username,
        producerId: p.id,
      }
    }
  }
  return null
}

/**
 * Close this peer's video producers of `source`. Closing fires each
 * producer's close observer (which drops it from the peer) and the
 * `producerclose` of every consumer, so viewers are told and a later share by
 * anyone is not refused as "already sharing". Returns the closed ids.
 */
export function closeVideoProducers(
  producers: Map<string, ProducerLike & { close(): void }>,
  source: VideoSource,
): string[] {
  const closed: string[] = []
  for (const p of [...producers.values()]) {
    if (p.closed || producerSource(p) !== source) continue
    try {
      p.close()
    } catch {
      /* already closed */
    }
    // Defensive: a fake or a producer whose observer did not run.
    producers.delete(p.id)
    closed.push(p.id)
  }
  return closed
}
