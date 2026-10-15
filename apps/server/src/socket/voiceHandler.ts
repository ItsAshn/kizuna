import type { Server, Socket } from 'socket.io'
import { v4 as uuidv4 } from 'uuid'
import {
  ensureRouter,
  createTransport,
  connectTransport,
  produceOnTransport,
  closeRouter,
} from '../media/router'
import type { types as mediasoupTypes } from 'mediasoup'
import { getDb } from '../db'
import { canViewChannel, getUserChannelPermission } from '../middleware/auth'
import { isId, isRecord } from './validate'
import { chooseSocketRtpFraming } from './socketRtpFraming'
import { resolveAccessibleRoom } from './chat/helpers'
import {
  closeVideoProducers,
  defaultPurpose,
  findScreenSharer,
  findVideoProducer,
  isTransportPurpose,
  maxIncomingBitrateBps,
  pickRecvTransport,
  producerSource,
  planTransportSlot,
  type TransportDirection,
  type TransportPurpose,
  type TransportSlot,
} from './voiceMedia'

type TransportWithDirection = mediasoupTypes.Transport & {
  _direction?: TransportDirection
  _purpose?: TransportPurpose
}

/** The bookkeeping view of a peer's transports that the voiceMedia helpers work on. */
function transportSlots(peer: PeerInfo): TransportSlot[] {
  return [...peer.transports.values()].map((t) => ({
    id: t.id,
    direction: t._direction ?? 'send',
    purpose: t._purpose ?? 'av',
    closed: t.closed,
  }))
}

function vts(): string {
  return new Date().toISOString().split('T')[1]?.slice(0, 12) ?? ''
}

const VERBOSE_VOICE_LOG = process.env.MEDIASOUP_LOG_LEVEL === 'debug'

function vlog(tag: string, msg: string, extras?: Record<string, unknown>) {
  if (!VERBOSE_VOICE_LOG) return
  const extra = extras ? ' ' + JSON.stringify(extras) : ''
  console.log(`[${vts()}] [Voice] ${tag}: ${msg}${extra}`)
}
function verr(tag: string, msg: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : String(err ?? '')
  console.error(`[${vts()}] [Voice] ${tag}: ${msg} | ${detail}`)
}

function getIceServers() {
  const servers: { urls: string; username?: string; credential?: string }[] = []
  const stunEnv =
    process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  const stunUrls = stunEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const url of stunUrls) {
    servers.push({ urls: url })
  }
  if (process.env.TURN_ENABLED === 'true' && process.env.TURN_URL) {
    const turnConfig: { urls: string; username?: string; credential?: string } = {
      urls: process.env.TURN_URL,
    }
    if (process.env.TURN_USERNAME) turnConfig.username = process.env.TURN_USERNAME
    if (process.env.TURN_PASSWORD) turnConfig.credential = process.env.TURN_PASSWORD
    servers.push(turnConfig)
  }
  return servers
}

export interface PeerInfo {
  socketId: string
  userId: string
  username: string
  channelId: string
  router: mediasoupTypes.Router
  transports: Map<string, TransportWithDirection>
  producers: Map<string, mediasoupTypes.Producer>
  consumers: Map<string, mediasoupTypes.Consumer>
  announced: boolean
  /** Self-mute state, mirrored to the channel so rosters can show it. */
  muted: boolean
  /** Server channel, 1:1 DM call (`dm:<id>`) or group-DM call (`group-dm:<id>`). */
  kind: VoiceRoomKind
}

type VoiceRoomKind = 'channel' | 'dm' | 'group-dm'

/** Channel types that carry voice. `screen` channels are voice rooms with a stage. */
const VOICE_CHANNEL_TYPES = new Set(['voice', 'screen'])

const TRANSPORT_RATE_WINDOW_MS = 10_000
const TRANSPORT_RATE_MAX = 10

const peers = new Map<string, PeerInfo>()
const channelPeers = new Map<string, Set<string>>()

/**
 * Sockets receiving forwarded Opus, mapped to the wire framing they negotiated.
 *
 *   1 — bare Opus payload (clients that predate sequence forwarding)
 *   2 — `[seq: u16 BE][timestamp: u32 BE][opus...]`
 *
 * Framing 2 exists because the receiver cannot do anything about packet loss
 * without sequence numbers: it cannot reorder, it cannot tell a lost frame from
 * a deliberate DTX pause, and it cannot use the Opus inband FEC the sender is
 * already paying bitrate for.
 */
const socketRtpFraming = new Map<string, number>()

const RTP_HEADER_BYTES = 12

/**
 * Strip the RTP header (CSRCs, header extension) and trailing padding,
 * returning the Opus payload with its seq and timestamp.
 */
function parseRtp(rtpPacket: Buffer): { seq: number; ts: number; payload: Buffer } | null {
  if (rtpPacket.length < RTP_HEADER_BYTES) return null
  const b0 = rtpPacket[0]!
  if (b0 >> 6 !== 2) return null // RTP version 2 only
  const hasPadding = (b0 & 0x20) !== 0
  const hasExtension = (b0 & 0x10) !== 0
  const csrcCount = b0 & 0x0f

  let end = rtpPacket.length
  if (hasPadding) {
    // The last byte holds the number of padding bytes, itself included.
    const padLen = rtpPacket[end - 1]!
    if (padLen === 0) return null
    end -= padLen
  }

  let offset = RTP_HEADER_BYTES + csrcCount * 4
  if (hasExtension) {
    if (offset + 4 > end) return null
    const extLen = rtpPacket.readUInt16BE(offset + 2)
    offset += 4 + extLen * 4
  }
  if (offset >= end) return null
  return {
    seq: rtpPacket.readUInt16BE(2),
    ts: rtpPacket.readUInt32BE(4),
    payload: rtpPacket.subarray(offset, end),
  }
}

/** Consumers that already have a forwarder, so a repeated enableSocketRtp can't double it. */
const forwardedConsumers = new WeakSet<mediasoupTypes.Consumer>()

/** Attach the `rtp` forwarder for one audio consumer, in the negotiated framing. */
function forwardConsumerRtp(
  socket: Socket,
  consumer: mediasoupTypes.Consumer,
  producerPeerId: string,
): void {
  if (forwardedConsumers.has(consumer)) return
  forwardedConsumers.add(consumer)
  consumer.on('rtp', (rtpPacket: Buffer) => {
    const parsed = parseRtp(rtpPacket)
    if (!parsed) return
    // Read the framing per packet: `voice:enableSocketRtp` may land after the
    // consumer was created, and the socket may have gone away entirely.
    const framing = socketRtpFraming.get(socket.id)
    if (framing === undefined) return
    // Volatile: a receiver that can't keep up drops packets (the jitter buffer
    // conceals them) instead of engine.io buffering audio for it without bound.
    if (framing >= 2) {
      const header = Buffer.allocUnsafe(6)
      header.writeUInt16BE(parsed.seq, 0)
      header.writeUInt32BE(parsed.ts, 2)
      socket.volatile.emit(
        'voice:socketRtp',
        Buffer.concat([header, parsed.payload]),
        producerPeerId,
      )
    } else {
      socket.volatile.emit('voice:socketRtp', parsed.payload, producerPeerId)
    }
  })
}

let cachedVoiceBitrate: number | null = null
let voiceBitrateCacheAt = 0
const VOICE_BITRATE_CACHE_TTL = 30_000

export function clearVoiceBitrateCache(): void {
  voiceBitrateCacheAt = 0
  cachedVoiceBitrate = null
}

export function getAllPeers(): PeerInfo[] {
  return Array.from(peers.values())
}

function getServerVoiceBitrateKbps(): number {
  const now = Date.now()
  if (cachedVoiceBitrate !== null && now - voiceBitrateCacheAt < VOICE_BITRATE_CACHE_TTL) {
    return cachedVoiceBitrate
  }
  const db = getDb()
  const row = db
    .prepare("SELECT value FROM server_settings WHERE key = 'voice_bitrate_kbps'")
    .get() as { value: string } | undefined
  let bitrate = 64
  if (row?.value) {
    const parsed = parseInt(row.value, 10)
    if (!isNaN(parsed) && parsed >= 8 && parsed <= 512) bitrate = parsed
  }
  if (!row?.value) {
    const envBitrate = parseInt(process.env.AUDIO_BITRATE_KBPS || '', 10)
    if (!isNaN(envBitrate) && envBitrate >= 8 && envBitrate <= 512) bitrate = envBitrate
  }
  cachedVoiceBitrate = bitrate
  voiceBitrateCacheAt = now
  return bitrate
}

export function getPeersInChannel(channelId: string): PeerInfo[] {
  const socketIds = channelPeers.get(channelId)
  if (!socketIds) return []
  const result: PeerInfo[] = []
  for (const sid of socketIds) {
    const peer = peers.get(sid)
    if (peer) result.push(peer)
  }
  return result
}

function getScreenSharer(
  channelId: string,
): { peerId: string; userId: string; username: string; producerId: string } | null {
  return findScreenSharer(getPeersInChannel(channelId))
}

type Ack = (res?: unknown) => void

function asAck(cb: unknown): Ack | undefined {
  return typeof cb === 'function' ? (cb as Ack) : undefined
}

function isMediaKind(v: unknown): v is 'audio' | 'video' {
  return v === 'audio' || v === 'video'
}

function isMediaSource(v: unknown): v is 'camera' | 'screen' {
  return v === 'camera' || v === 'screen'
}

/**
 * Authorise a voice room id exactly as the client sends it:
 *   `dm:<dmChannelId>`        — 1:1 DM call, caller must be a party to the DM
 *   `group-dm:<groupId>`      — group call, caller must be a group member
 *   `<channelId>`             — server voice channel the caller can view and
 *                               has `use_voice` on (channel overrides applied)
 */
function authorizeVoiceRoom(
  userId: string,
  channelId: string,
): { kind: VoiceRoomKind } | { error: string } {
  if (channelId.startsWith('dm:')) {
    const room = resolveAccessibleRoom(userId, channelId.slice(3))
    return room?.kind === 'dm' ? { kind: 'dm' } : { error: 'Not a participant in this DM' }
  }
  if (channelId.startsWith('group-dm:')) {
    const room = resolveAccessibleRoom(userId, channelId.slice(9))
    return room?.kind === 'group-dm'
      ? { kind: 'group-dm' }
      : { error: 'Not a member of this group DM' }
  }
  const room = resolveAccessibleRoom(userId, channelId)
  if (!room || room.kind !== 'channel') return { error: 'Voice channel not found' }
  if (!VOICE_CHANNEL_TYPES.has(room.type ?? '')) return { error: 'Not a voice channel' }
  const member = getDb().prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(userId)
  if (!member) return { error: 'Not a server member' }
  if (!getUserChannelPermission(userId, channelId, 'use_voice')) {
    return { error: 'You do not have permission to join voice channels' }
  }
  return { kind: 'channel' }
}

/** Whether `userId` may see who is in voice room `channelId`. */
function canSeeVoiceRoom(userId: string, channelId: string): boolean {
  if (channelId.startsWith('dm:')) {
    return resolveAccessibleRoom(userId, channelId.slice(3))?.kind === 'dm'
  }
  if (channelId.startsWith('group-dm:')) {
    return resolveAccessibleRoom(userId, channelId.slice(9))?.kind === 'group-dm'
  }
  return canViewChannel(userId, channelId)
}

/** Memoise canSeeVoiceRoom per (user, room) for the duration of one fan-out. */
function visibilityChecker(): (userId: string, channelId: string) => boolean {
  const cache = new Map<string, boolean>()
  return (userId, channelId) => {
    const key = `${userId}\u0000${channelId}`
    let ok = cache.get(key)
    if (ok === undefined) {
      ok = canSeeVoiceRoom(userId, channelId)
      cache.set(key, ok)
    }
    return ok
  }
}

/**
 * Roster broadcasts (who is in which voice room) go only to sockets whose user
 * can see that room: hidden channels stay hidden and DM/group calls are only
 * visible to their own participants.
 */
function emitToVoiceRoomViewers(
  io: Server,
  channelId: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  const canSee = visibilityChecker()
  for (const [, s] of io.sockets.sockets) {
    const uid = s.data.userId as string | undefined
    if (uid && canSee(uid, channelId)) s.emit(event, payload)
  }
}

/** Drop transports that already closed (DTLS failure, router close) from the peer. */
function pruneClosedTransports(peer: PeerInfo): void {
  for (const [id, t] of peer.transports) {
    if (t.closed) peer.transports.delete(id)
  }
}

/**
 * Make room for one more transport in `(direction, purpose)`, closing the one
 * it replaces: a client re-creates a transport after a failure, or when it
 * restarts camera/screen without telling the server. Returns an error string
 * when the peer is already at its transport cap.
 */
function makeRoomForTransport(
  peer: PeerInfo,
  direction: TransportDirection,
  purpose: TransportPurpose,
): string | null {
  pruneClosedTransports(peer)
  const plan = planTransportSlot(transportSlots(peer), direction, purpose)
  if (plan.error) return plan.error
  for (const id of plan.replace) {
    const t = peer.transports.get(id)
    vlog('createTransport', `replacing ${direction}/${purpose} transport | transportId=${id}`)
    try {
      t?.close()
    } catch {
      /* already closed */
    }
    peer.transports.delete(id)
  }
  return null
}

/** Register a freshly created transport on the peer and keep the map in sync. */
function trackTransport(
  peer: PeerInfo,
  transport: TransportWithDirection,
  direction: TransportDirection,
  purpose: TransportPurpose,
) {
  transport._direction = direction
  transport._purpose = purpose
  peer.transports.set(transport.id, transport)
  transport.observer.once('close', () => {
    if (peer.transports.get(transport.id) === transport) peer.transports.delete(transport.id)
  })
}

export function registerVoiceHandlers(io: Server, socket: Socket): void {
  // Sliding-window limit on transport creation for this socket. Each one
  // allocates ports and worker state, so it is the expensive call to spam.
  const transportCreations: number[] = []
  function allowTransportCreation(): boolean {
    const now = Date.now()
    while (transportCreations.length && now - transportCreations[0]! > TRANSPORT_RATE_WINDOW_MS) {
      transportCreations.shift()
    }
    if (transportCreations.length >= TRANSPORT_RATE_MAX) return false
    transportCreations.push(now)
    return true
  }

  socket.on('voice:join', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    const joinTs = Date.now()
    const userId = socket.data.userId as string | undefined
    const username = socket.data.username as string
    if (!userId) {
      vlog('join', 'rejected: not authenticated')
      callback?.({ error: 'Authentication required' })
      return
    }
    if (!isRecord(payload) || !isId(payload.channelId, 160)) {
      callback?.({ error: 'Invalid channel' })
      return
    }
    const channelId = payload.channelId
    vlog(
      'join',
      `request | socketId=${socket.id} | channelId=${channelId} | userId=${userId} | username=${username} | peers=${peers.size}`,
    )
    try {
      const auth = authorizeVoiceRoom(userId, channelId)
      if ('error' in auth) {
        vlog('join', `rejected: ${auth.error} | userId=${userId} | channelId=${channelId}`)
        callback?.({ error: auth.error })
        return
      }

      // Re-joining (switching channels, or a retry) must tear the previous
      // session down first, or its transports/producers leak and the old
      // channel keeps a ghost peer that stops its router from ever closing.
      cleanupPeer(io, socket)

      const router = await ensureRouter(channelId)
      vlog('join', `router ready | channelId=${channelId}`)

      // The socket may have gone, or a concurrent join may have won, while the
      // router was being created.
      if (!socket.connected) return
      cleanupPeer(io, socket)

      socket.join(channelId)

      const peer: PeerInfo = {
        socketId: socket.id,
        userId,
        username,
        channelId,
        router,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
        announced: false,
        muted: false,
        kind: auth.kind,
      }
      peers.set(socket.id, peer)
      if (!channelPeers.has(channelId)) channelPeers.set(channelId, new Set())
      channelPeers.get(channelId)!.add(socket.id)

      if (auth.kind === 'group-dm') {
        const groupChannelId = channelId.slice(9)
        const vpId = uuidv4()
        getDb()
          .prepare(
            'INSERT INTO group_dm_voice_participants (id, channel_id, user_id, joined_at) VALUES (?, ?, ?, ?)',
          )
          .run(vpId, groupChannelId, userId, Math.floor(Date.now() / 1000))
      }

      const existingPeers: {
        id: string
        userId: string
        username: string
        speaking: boolean
        muted: boolean
        hasCamera: boolean
        cameraProducerId?: string
      }[] = []
      for (const p of getPeersInChannel(channelId)) {
        if (p.socketId !== socket.id && p.announced) {
          const camera = findVideoProducer(p.producers.values(), 'camera')
          existingPeers.push({
            id: p.socketId,
            userId: p.userId,
            username: p.username,
            speaking: false,
            muted: p.muted,
            hasCamera: !!camera,
            ...(camera ? { cameraProducerId: camera.id } : {}),
          })
        }
      }

      const iceServers = getIceServers()
      const screenSharePeer = getScreenSharer(channelId)
      const voiceBitrateKbps = getServerVoiceBitrateKbps()
      vlog(
        'join',
        `success | socketId=${socket.id} | username=${username} | channelPeers=${existingPeers.length} | iceServers=${iceServers.length} | screenShare=${!!screenSharePeer} | voiceBitrate=${voiceBitrateKbps}kbps | ms=${Date.now() - joinTs}`,
      )

      callback?.({
        routerRtpCapabilities: router.rtpCapabilities,
        peers: existingPeers,
        iceServers,
        screenSharePeer,
        voiceBitrateKbps,
      })
    } catch (err: unknown) {
      verr('join', 'error', err)
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  socket.on('voice:createTransport', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    const t0 = Date.now()
    const direction = isRecord(payload) ? payload.direction : undefined
    if (direction !== 'send' && direction !== 'recv') {
      callback?.({ error: 'Invalid direction' })
      return
    }
    const requestedPurpose = isRecord(payload) ? payload.purpose : undefined
    if (requestedPurpose !== undefined && !isTransportPurpose(requestedPurpose)) {
      callback?.({ error: 'Invalid purpose' })
      return
    }
    try {
      const peer = peers.get(socket.id)
      if (!peer) {
        vlog('createTransport', `rejected: not in voice channel | socketId=${socket.id}`)
        callback?.({ error: 'Not in a voice channel' })
        return
      }
      if (!allowTransportCreation()) {
        callback?.({ error: 'Too many transport requests, slow down' })
        return
      }

      const transport = (await createTransport(peer.router)) as TransportWithDirection

      // Checked after the await so concurrent requests can't both slip under
      // the cap, and a peer that left/rejoined meanwhile doesn't adopt it.
      const purpose: TransportPurpose =
        requestedPurpose ?? defaultPurpose(direction, transportSlots(peer))
      const slotError =
        peers.get(socket.id) === peer
          ? makeRoomForTransport(peer, direction, purpose)
          : 'Not in a voice channel'
      if (slotError) {
        transport.close()
        callback?.({ error: slotError })
        return
      }

      // Per purpose: an audio-only transport is held to the voice bitrate,
      // but one that carries video needs megabits — capping every send
      // transport at the voice bitrate is what held screenshare to 64 kbps.
      const maxIncomingBps = maxIncomingBitrateBps(purpose, getServerVoiceBitrateKbps())
      if (direction === 'send') {
        ;(transport as mediasoupTypes.WebRtcTransport)
          .setMaxIncomingBitrate(maxIncomingBps)
          .catch((e) => {
            verr('createTransport', `setMaxIncomingBitrate failed`, e)
          })
      }
      trackTransport(peer, transport, direction, purpose)

      vlog(
        'createTransport',
        `created | socketId=${socket.id} | dir=${direction} | purpose=${purpose} | transportId=${transport.id} | maxIncoming=${maxIncomingBps} | ms=${Date.now() - t0}`,
      )

      const webrtc = transport as mediasoupTypes.WebRtcTransport
      webrtc.on('dtlsstatechange', (state: string) => {
        vlog(
          'dtls',
          `${direction} dtlsstatechange -> ${state} | socketId=${socket.id} | transportId=${transport.id}`,
        )
        if (state === 'failed' || state === 'closed') {
          verr('dtls', `${direction} dtls ${state} | socketId=${socket.id}`)
          try {
            transport.close()
          } catch {
            /* already closed */
          }
        }
      })

      callback?.({
        id: webrtc.id,
        iceParameters: webrtc.iceParameters,
        iceCandidates: webrtc.iceCandidates,
        dtlsParameters: webrtc.dtlsParameters,
      })
    } catch (err: unknown) {
      verr('createTransport', `failed | socketId=${socket.id} | dir=${direction}`, err)
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  socket.on('voice:createDirectTransport', async (_payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    try {
      const peer = peers.get(socket.id)
      if (!peer) {
        callback?.({ error: 'Not in a voice channel' })
        return
      }
      if (!allowTransportCreation()) {
        callback?.({ error: 'Too many transport requests, slow down' })
        return
      }

      const direct = await peer.router.createDirectTransport({
        maxSendMessageSize: 262144,
      })
      direct.on('rtcp', () => {})
      const transport = direct as TransportWithDirection

      // A DirectTransport only ever carries the forwarded Opus of native
      // clients, so it is the audio recv slot.
      const slotError =
        peers.get(socket.id) === peer
          ? makeRoomForTransport(peer, 'recv', 'audio')
          : 'Not in a voice channel'
      if (slotError) {
        transport.close()
        callback?.({ error: slotError })
        return
      }
      trackTransport(peer, transport, 'recv', 'audio')

      vlog('createDirectTransport', `created | socketId=${socket.id} | transportId=${transport.id}`)

      callback?.({ id: transport.id })
    } catch (err: unknown) {
      verr('createDirectTransport', `failed | socketId=${socket.id}`, err)
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  socket.on('voice:connectTransport', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    if (!isRecord(payload) || !isId(payload.transportId) || !isRecord(payload.dtlsParameters)) {
      callback?.({ error: 'Invalid payload' })
      return
    }
    const transportId = payload.transportId
    try {
      const peer = peers.get(socket.id)
      const transport = peer?.transports.get(transportId)
      if (!transport || transport.closed) {
        vlog('connectTransport', `rejected: transport not found | transportId=${transportId}`)
        callback?.({ error: 'Transport not found' })
        return
      }
      const dir = transport._direction || '?'
      await connectTransport(
        transport as mediasoupTypes.WebRtcTransport,
        payload.dtlsParameters as unknown as mediasoupTypes.DtlsParameters,
      )
      vlog(
        'connectTransport',
        `ok | socketId=${socket.id} | dir=${dir} | transportId=${transportId}`,
      )
      callback?.({ ok: true })
    } catch (err: unknown) {
      verr('connectTransport', `failed | transportId=${transportId}`, err)
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  socket.on('voice:produce', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    if (
      !isRecord(payload) ||
      !isId(payload.transportId) ||
      !isMediaKind(payload.kind) ||
      !isRecord(payload.rtpParameters) ||
      (payload.source !== undefined && payload.source !== null && !isMediaSource(payload.source))
    ) {
      callback?.({ error: 'Invalid payload' })
      return
    }
    const { transportId, kind } = payload
    const source = isMediaSource(payload.source) ? payload.source : undefined
    try {
      const peer = peers.get(socket.id)
      const transport = peer?.transports.get(transportId)
      if (!peer || !transport || transport.closed) {
        vlog('produce', `rejected: transport not found | transportId=${transportId}`)
        callback?.({ error: 'Transport not found' })
        return
      }

      const producer = await produceOnTransport(transport as mediasoupTypes.WebRtcTransport, {
        kind,
        rtpParameters: payload.rtpParameters as unknown as mediasoupTypes.RtpParameters,
        source,
      })
      if (peers.get(socket.id) !== peer) {
        // Left or switched channel while producing.
        producer.close()
        callback?.({ error: 'Not in a voice channel' })
        return
      }
      peer.producers.set(producer.id, producer)
      producer.observer.once('close', () => peer.producers.delete(producer.id))
      vlog(
        'produce',
        `created | socketId=${socket.id} | user=${peer.username} | kind=${kind} | producerId=${producer.id} | announced=${peer.announced}`,
      )

      producer.on('transportclose', () => producer.close())

      if (!peer.announced) {
        peer.announced = true
        vlog(
          'produce',
          `announcing new peer | socketId=${socket.id} | user=${peer.username} | channelPeers=${peers.size}`,
        )
        socket.to(peer.channelId).emit('voice:newPeer', {
          peerId: socket.id,
          userId: peer.userId,
          username: peer.username,
        })
        emitToVoiceRoomViewers(io, peer.channelId, 'voice:userJoinedChannel', {
          channelId: peer.channelId,
          userId: peer.userId,
          username: peer.username,
        })
      }

      callback?.({ id: producer.id })
    } catch (err: unknown) {
      verr('produce', `failed | socketId=${socket.id}`, err)
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  socket.on('voice:consume', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    if (
      !isRecord(payload) ||
      !isId(payload.peerId) ||
      !isRecord(payload.rtpCapabilities) ||
      (payload.kind !== undefined && payload.kind !== null && !isMediaKind(payload.kind)) ||
      (payload.source !== undefined && payload.source !== null && !isMediaSource(payload.source)) ||
      (payload.transportId !== undefined &&
        payload.transportId !== null &&
        !isId(payload.transportId))
    ) {
      callback?.({ error: 'Invalid payload' })
      return
    }
    const peerId = payload.peerId
    const rtpCapabilities = payload.rtpCapabilities as unknown as mediasoupTypes.RtpCapabilities
    const kind = isMediaKind(payload.kind) ? payload.kind : undefined
    const source = isMediaSource(payload.source) ? payload.source : undefined
    const transportId = isId(payload.transportId) ? payload.transportId : undefined
    try {
      const requestingPeer = peers.get(socket.id)
      if (!requestingPeer) {
        callback?.({ error: 'Requesting peer not found' })
        return
      }

      const slot = pickRecvTransport(transportSlots(requestingPeer), kind ?? 'audio', transportId)
      const recvTransport = slot ? (requestingPeer.transports.get(slot.id) ?? null) : null
      if (!recvTransport) {
        vlog('consume', `rejected: no recv transport | socketId=${socket.id} | peerId=${peerId}`)
        callback?.({ error: 'Recv transport not found' })
        return
      }

      const targetPeer = peers.get(peerId)
      if (!targetPeer || targetPeer.channelId !== requestingPeer.channelId) {
        vlog('consume', `rejected: target peer not found | peerId=${peerId}`)
        callback?.({ error: 'Target peer not found' })
        return
      }

      const targetKind = kind || 'audio'
      let producerId: string | null = null
      for (const [id, producer] of targetPeer.producers) {
        if (producer.closed || producer.kind !== targetKind) continue
        // For video, disambiguate camera vs screenshare by source when requested.
        if (targetKind === 'video' && source && producerSource(producer) !== source) continue
        producerId = id
        break
      }
      if (!producerId) {
        vlog(
          'consume',
          `rejected: no ${targetKind}${source ? `/${source}` : ''} producer | peerId=${peerId}`,
        )
        callback?.({ error: `Target peer has no ${targetKind} producer` })
        return
      }

      if (!requestingPeer.router.canConsume({ producerId, rtpCapabilities })) {
        vlog('consume', `rejected: router cannot consume | producerId=${producerId}`)
        callback?.({ error: 'Router cannot consume this producer' })
        return
      }

      const consumer = await recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      })
      if (peers.get(socket.id) !== requestingPeer) {
        consumer.close()
        callback?.({ error: 'Not in a voice channel' })
        return
      }
      vlog(
        'consume',
        `created | socketId=${socket.id} -> producerId=${producerId} | consumerId=${consumer.id} | kind=${consumer.kind} | paused=${consumer.producerPaused}`,
      )

      requestingPeer.consumers.set(consumer.id, consumer)
      consumer.observer.once('close', () => requestingPeer.consumers.delete(consumer.id))
      consumer.on('transportclose', () => consumer.close())
      consumer.on('producerclose', () => {
        consumer.close()
        socket.emit('voice:consumerClosed', {
          consumerId: consumer.id,
          producerId,
          peerId,
          kind: consumer.kind,
        })
      })

      if (socketRtpFraming.has(socket.id) && consumer.kind === 'audio') {
        forwardConsumerRtp(socket, consumer, peerId)
      }

      callback?.({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        paused: consumer.producerPaused,
        transportId: recvTransport.id,
      })
    } catch (err: unknown) {
      verr('consume', `failed | peerId=${peerId}`, err)
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  socket.on('voice:resumeConsumer', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    if (!isRecord(payload) || !isId(payload.consumerId)) {
      callback?.()
      return
    }
    const consumerId = payload.consumerId
    try {
      const peer = peers.get(socket.id)
      const consumer = peer?.consumers.get(consumerId)
      if (consumer && !consumer.closed) {
        await consumer.resume()
        vlog('resumeConsumer', `ok | socketId=${socket.id} | consumerId=${consumerId}`)
      } else {
        vlog('resumeConsumer', `not found | socketId=${socket.id} | consumerId=${consumerId}`)
      }
      callback?.()
    } catch (err: unknown) {
      verr('resumeConsumer', `failed | consumerId=${consumerId}`, err)
      callback?.()
    }
  })

  // A viewer that stops watching (closes the tile, or drops a video it can no
  // longer decode) releases its consumer instead of leaving the SFU forwarding
  // megabits nobody looks at until the call ends.
  socket.on('voice:closeConsumer', (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    if (!isRecord(payload) || !isId(payload.consumerId)) {
      callback?.({ error: 'Invalid payload' })
      return
    }
    const consumer = peers.get(socket.id)?.consumers.get(payload.consumerId)
    if (consumer && !consumer.closed) consumer.close()
    callback?.({ ok: true })
  })

  // Native receivers send their PLIs here rather than over RTCP: the server
  // asks the producer for a keyframe directly, which also works on transports
  // whose RTCP feedback the client cannot drive.
  socket.on('voice:requestKeyFrame', async (payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    if (!isRecord(payload) || !isId(payload.consumerId)) {
      callback?.({ error: 'Invalid payload' })
      return
    }
    const consumer = peers.get(socket.id)?.consumers.get(payload.consumerId)
    if (!consumer || consumer.closed || consumer.kind !== 'video') {
      callback?.({ error: 'Consumer not found' })
      return
    }
    try {
      await consumer.requestKeyFrame()
      callback?.({ ok: true })
    } catch (err: unknown) {
      callback?.({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // The client still sends its channelId on these; it is ignored in favour of
  // the channel the server actually placed the peer in.
  socket.on('voice:speaking', (payload: unknown) => {
    if (!isRecord(payload)) return
    const peer = peers.get(socket.id)
    if (!peer) return
    socket.to(peer.channelId).emit('voice:peerSpeaking', {
      peerId: socket.id,
      speaking: payload.speaking === true,
    })
  })

  // Self-mute. Persisted on the peer so someone joining later sees who is
  // already muted rather than an all-unmuted roster, and broadcast with the
  // peer id the client keys its roster by (userId is included for callers that
  // only track users).
  socket.on('voice:mute', (payload: unknown) => {
    if (!isRecord(payload)) return
    const peer = peers.get(socket.id)
    if (!peer) return
    peer.muted = !!payload.muted
    io.to(peer.channelId).emit('voice:mute', {
      peerId: socket.id,
      userId: peer.userId,
      muted: peer.muted,
    })
  })

  socket.on('screen:start', async (_payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    const peer = peers.get(socket.id)
    if (!peer) {
      callback?.({ error: 'Not in a voice channel' })
      return
    }
    const channelId = peer.channelId
    const existing = getScreenSharer(channelId)
    if (existing && existing.peerId !== socket.id) {
      callback?.({ error: 'Someone else is already sharing' })
      return
    }
    // A screen-source video producer must already exist.
    const screenProducer = findVideoProducer(peer.producers.values(), 'screen')
    if (!screenProducer) {
      callback?.({ error: 'No video producer found' })
      return
    }
    console.log(`[Screen] START | channel=${channelId} | user=${peer.username}`)
    socket.to(channelId).emit('screen:peerStarted', {
      peerId: socket.id,
      userId: peer.userId,
      username: peer.username,
      producerId: screenProducer.id,
    })
    callback?.({ ok: true, producerId: screenProducer.id })
  })

  // Stopping closes the producer here rather than trusting the client to: a
  // producer left open kept getScreenSharer answering "already sharing" for
  // everyone else until the sharer left the call.
  socket.on('screen:stop', (_payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    const peer = peers.get(socket.id)
    if (!peer) {
      callback?.({ ok: true })
      return
    }
    const closed = closeVideoProducers(peer.producers, 'screen')
    console.log(
      `[Screen] STOP | channel=${peer.channelId} | user=${peer.username} | closed=${closed.length}`,
    )
    io.to(peer.channelId).emit('screen:peerStopped', { peerId: socket.id })
    callback?.({ ok: true })
  })

  socket.on('camera:started', (payload: unknown) => {
    const peer = peers.get(socket.id)
    if (!peer) return
    // Prefer the producer the client names, but only if it is really this
    // peer's camera; otherwise fall back to whatever camera it has.
    const named =
      isRecord(payload) && isId(payload.producerId)
        ? peer.producers.get(payload.producerId)
        : undefined
    const camera =
      named && !named.closed && producerSource(named) === 'camera'
        ? named
        : findVideoProducer(peer.producers.values(), 'camera')
    if (!camera) return
    console.log(`[Camera] START | channel=${peer.channelId} | user=${peer.username}`)
    socket.to(peer.channelId).emit('camera:peerStarted', {
      peerId: socket.id,
      userId: peer.userId,
      username: peer.username,
      producerId: camera.id,
    })
  })

  socket.on('camera:stopped', (_payload: unknown, cb?: unknown) => {
    const callback = asAck(cb)
    const peer = peers.get(socket.id)
    if (!peer) {
      callback?.({ ok: true })
      return
    }
    const closed = closeVideoProducers(peer.producers, 'camera')
    console.log(
      `[Camera] STOP | channel=${peer.channelId} | user=${peer.username} | closed=${closed.length}`,
    )
    io.to(peer.channelId).emit('camera:peerStopped', { peerId: socket.id })
    callback?.({ ok: true })
  })

  socket.on('voice:leave', () => {
    cleanupPeer(io, socket)
  })

  socket.on('voice:getOccupancy', (...args: unknown[]) => {
    // Clients call this with only an ack, so it is the last argument rather
    // than a fixed position.
    const callback = asAck(args[args.length - 1])
    if (!callback) return
    const userId = socket.data.userId as string | undefined
    const channels: Record<string, { userId: string; username: string }[]> = {}
    if (userId) {
      const canSee = visibilityChecker()
      for (const [, peer] of peers) {
        if (!peer.announced) continue
        if (!canSee(userId, peer.channelId)) continue
        if (!channels[peer.channelId]) channels[peer.channelId] = []
        channels[peer.channelId]!.push({ userId: peer.userId, username: peer.username })
      }
    }
    callback({ channels })
  })

  socket.on('voice:enableSocketRtp', (opts?: unknown, cb?: unknown) => {
    // Older clients call this with no arguments at all.
    const ack = typeof opts === 'function' ? asAck(opts) : asAck(cb)
    const framing = chooseSocketRtpFraming(opts)

    // The ack carries the framing this server chose, and is sent before the
    // framing is recorded: forwarding (which reads it per packet) cannot start
    // until this handler returns, so the ack is always the first thing the
    // client hears and it never has to guess what the payloads look like.
    // Repeat requests (a client retrying after a slow ack) get the same answer.
    ack?.({ framing })
    vlog('socketRtp', `enabled | socketId=${socket.id} | framing=${framing}`)
    socketRtpFraming.set(socket.id, framing)

    const peer = peers.get(socket.id)
    if (peer) {
      let count = 0
      for (const [, consumer] of peer.consumers) {
        if (consumer.kind !== 'audio') continue
        // Find which peer owns this producer to get the correct socket ID
        let producerPeerId = consumer.producerId
        for (const [sid, p] of peers) {
          if (p.producers.has(consumer.producerId)) {
            producerPeerId = sid
            break
          }
        }
        forwardConsumerRtp(socket, consumer, producerPeerId)
        count++
      }
      vlog('socketRtp', `registered ${count} existing consumers | socketId=${socket.id}`)
    }
  })

  socket.on('disconnect', () => {
    socketRtpFraming.delete(socket.id)
    cleanupPeer(io, socket)
  })
}

/**
 * Tear down this socket's voice session, if it has one: close its media,
 * remove it from the channel roster, tell the room and the roster viewers,
 * and schedule the router for closing once the channel is empty. Safe to call
 * when the socket is not in voice.
 */
function cleanupPeer(io: Server, socket: Socket): void {
  const socketId = socket.id
  const peer = peers.get(socketId)
  if (!peer) return
  const channelId = peer.channelId

  let wasSharing = false
  let hadCamera = false
  let producerCount = 0
  for (const [, p] of peer.producers) {
    producerCount++
    if (p.kind !== 'video') continue
    if (p.appData?.source === 'camera') hadCamera = true
    else wasSharing = true
  }

  vlog(
    'cleanup',
    `peer leaving | socketId=${socketId} | user=${peer.username} | channelId=${channelId} | producers=${producerCount} | consumers=${peer.consumers.size} | transports=${peer.transports.size} | wasSharing=${wasSharing} | remainingPeers=${peers.size - 1}`,
  )

  // Remove the peer first so the close observers below see it is gone.
  peers.delete(socketId)
  const roster = channelPeers.get(channelId)
  roster?.delete(socketId)
  if (roster && roster.size === 0) channelPeers.delete(channelId)

  for (const p of [...peer.producers.values()]) {
    try {
      p.close()
    } catch {
      /* already closed */
    }
  }
  for (const c of [...peer.consumers.values()]) {
    try {
      c.close()
    } catch {
      /* already closed */
    }
  }
  for (const t of [...peer.transports.values()]) {
    try {
      t.close()
    } catch {
      /* already closed */
    }
  }
  peer.producers.clear()
  peer.consumers.clear()
  peer.transports.clear()

  socket.leave(channelId)

  io.to(channelId).emit('voice:peerLeft', { peerId: socketId })
  if (peer.announced) {
    emitToVoiceRoomViewers(io, channelId, 'voice:userLeftChannel', {
      channelId,
      userId: peer.userId,
    })
  }
  if (wasSharing) {
    io.to(channelId).emit('screen:peerStopped', { peerId: socketId })
  }
  if (hadCamera) {
    io.to(channelId).emit('camera:peerStopped', { peerId: socketId })
  }

  if (peer.kind === 'group-dm') {
    const groupChannelId = channelId.slice(9)
    try {
      const db = getDb()
      const now = Math.floor(Date.now() / 1000)
      db.prepare(
        `UPDATE group_dm_voice_participants SET left_at = ?
         WHERE channel_id = ? AND user_id = ? AND left_at IS NULL
         ORDER BY joined_at DESC LIMIT 1`,
      ).run(now, groupChannelId, peer.userId)
    } catch {
      /* ignore */
    }
  }

  if (!channelPeers.has(channelId)) {
    setTimeout(() => {
      if ((channelPeers.get(channelId)?.size ?? 0) === 0) {
        vlog('cleanup', `closing router for empty channel ${channelId}`)
        closeRouter(channelId)
      }
    }, 30_000)
  }
}
