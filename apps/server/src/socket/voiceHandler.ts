import type { Server, Socket } from 'socket.io'
import { ensureRouter, createTransport, connectTransport, produceOnTransport, consumeOnTransport } from '../media/router'
import type { types as mediasoupTypes } from 'mediasoup'
import { getDb } from '../db'

function vts(): string {
  return new Date().toISOString().split('T')[1].slice(0, 12)
}
function vlog(tag: string, msg: string, extras?: Record<string, unknown>) {
  const extra = extras ? ' ' + JSON.stringify(extras) : ''
  console.log(`[${vts()}] [Voice] ${tag}: ${msg}${extra}`)
}
function verr(tag: string, msg: string, err?: unknown) {
  const detail = err instanceof Error ? err.message : String(err ?? '')
  console.error(`[${vts()}] [Voice] ${tag}: ${msg} | ${detail}`)
}

function getIceServers() {
  const servers: { urls: string; username?: string; credential?: string }[] = []
  const stunEnv = process.env.STUN_SERVERS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'
  const stunUrls = stunEnv.split(',').map(s => s.trim()).filter(Boolean)
  for (const url of stunUrls) {
    servers.push({ urls: url })
  }
  if (process.env.TURN_ENABLED === 'true' && process.env.TURN_URL) {
    const turnConfig: { urls: string; username?: string; credential?: string } = { urls: process.env.TURN_URL }
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
  transports: Map<string, any>
  producers: Map<string, mediasoupTypes.Producer>
  consumers: Map<string, mediasoupTypes.Consumer>
  announced: boolean
}

const peers = new Map<string, PeerInfo>()
const socketRtpEnabled = new Set<string>()

export function getAllPeers(): PeerInfo[] {
  return Array.from(peers.values())
}

function getServerVoiceBitrateKbps(): number {
  const db = getDb()
  const row = db.prepare("SELECT value FROM server_settings WHERE key = 'voice_bitrate_kbps'").get() as { value: string } | undefined
  if (row?.value) {
    const parsed = parseInt(row.value, 10)
    if (!isNaN(parsed) && parsed >= 8 && parsed <= 512) return parsed
  }
  const envBitrate = parseInt(process.env.AUDIO_BITRATE_KBPS || '', 10)
  if (!isNaN(envBitrate) && envBitrate >= 8 && envBitrate <= 512) return envBitrate
  return 64
}

export function getPeersInChannel(channelId: string): PeerInfo[] {
  const result: PeerInfo[] = []
  for (const peer of peers.values()) {
    if (peer.channelId === channelId) result.push(peer)
  }
  return result
}

function getScreenSharer(channelId: string): { peerId: string; userId: string; username: string } | null {
  for (const peer of peers.values()) {
    if (peer.channelId !== channelId) continue
    for (const [, producer] of peer.producers) {
      if (producer.kind === 'video') {
        return { peerId: peer.socketId, userId: peer.userId, username: peer.username }
      }
    }
  }
  return null
}

export function registerVoiceHandlers(io: Server, socket: Socket): void {
  socket.on('voice:join', async ({ channelId }: {
    channelId: string
  }, callback?: Function) => {
    const joinTs = Date.now()
    let userId = socket.data.userId
    let username = socket.data.username
    if (!userId) {
      vlog('join', 'rejected: not authenticated')
      if (typeof callback === 'function') callback({ error: 'Authentication required' })
      return
    }
    vlog('join', `request | socketId=${socket.id} | channelId=${channelId} | userId=${userId} | username=${username} | peers=${peers.size}`)
    try {
      const db = getDb()
      const member = db.prepare('SELECT 1 FROM server_members WHERE user_id = ?').get(userId)
      if (!member) {
        vlog('join', `rejected: not a server member | userId=${userId}`)
        if (typeof callback === 'function') callback({ error: 'Not a server member' })
        return
      }

      const router = await ensureRouter(channelId)
      vlog('join', `router ready | channelId=${channelId}`)

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
      }
      peers.set(socket.id, peer)

      const channelPeers: { id: string; userId: string; username: string; speaking: boolean; muted: boolean }[] = []
      for (const p of getPeersInChannel(channelId)) {
        if (p.socketId !== socket.id && p.announced) {
          channelPeers.push({
            id: p.socketId,
            userId: p.userId,
            username: p.username,
            speaking: false,
            muted: false,
          })
        }
      }

      const iceServers = getIceServers()
      const screenSharePeer = getScreenSharer(channelId)
      const voiceBitrateKbps = getServerVoiceBitrateKbps()
      vlog('join', `success | socketId=${socket.id} | username=${username} | channelPeers=${channelPeers.length} | iceServers=${iceServers.length} | screenShare=${!!screenSharePeer} | voiceBitrate=${voiceBitrateKbps}kbps | ms=${Date.now() - joinTs}`)

      if (typeof callback === 'function') {
        callback({
          routerRtpCapabilities: router.rtpCapabilities,
          peers: channelPeers,
          iceServers,
          screenSharePeer,
          voiceBitrateKbps,
        })
      }
    } catch (err: any) {
      verr('join', 'error', err)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:createTransport', async ({ channelId, direction }: {
    channelId: string
    direction: string
  }, callback?: Function) => {
    const t0 = Date.now()
    try {
      const peer = peers.get(socket.id)
      if (!peer) {
        vlog('createTransport', `rejected: not in voice channel | socketId=${socket.id}`)
        if (typeof callback === 'function') callback({ error: 'Not in a voice channel' })
        return
      }

      const transport = await createTransport(peer.router);
      (transport as any)._direction = direction
      peer.transports.set(transport.id, transport as any)

      const bitrateKbps = getServerVoiceBitrateKbps()
      if (direction === 'send') {
        transport.setMaxIncomingBitrate(bitrateKbps * 1000).catch((e) => {
          verr('createTransport', `setMaxIncomingBitrate failed`, e)
        })
      }

      vlog('createTransport', `created | socketId=${socket.id} | dir=${direction} | transportId=${transport.id} | bitrate=${bitrateKbps}kbps | ms=${Date.now() - t0}`)

      transport.on('dtlsstatechange', (state: string) => {
        vlog('dtls', `${direction} dtlsstatechange -> ${state} | socketId=${socket.id} | transportId=${transport.id}`)
        if (state === 'failed' || state === 'closed') {
          verr('dtls', `${direction} dtls ${state} | socketId=${socket.id}`)
          try { transport.close() } catch {}
        }
      })

      if (typeof callback === 'function') {
        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        })
      }
    } catch (err: any) {
      verr('createTransport', `failed | socketId=${socket.id} | dir=${direction}`, err)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:createDirectTransport', async ({ channelId }: {
    channelId: string
  }, callback?: Function) => {
    try {
      const peer = peers.get(socket.id)
      if (!peer) {
        if (typeof callback === 'function') callback({ error: 'Not in a voice channel' })
        return
      }

      const transport = await peer.router.createDirectTransport({
        maxMessageSize: 262144,
      } as any);
      (transport as any)._direction = 'recv'
      peer.transports.set(transport.id, transport)

      transport.on('rtcp', () => {})

      vlog('createDirectTransport', `created | socketId=${socket.id} | transportId=${transport.id}`)

      if (typeof callback === 'function') {
        callback({ id: transport.id })
      }
    } catch (err: any) {
      verr('createDirectTransport', `failed | socketId=${socket.id}`, err)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:connectTransport', async ({ channelId, transportId, dtlsParameters }: {
    channelId: string
    transportId: string
    dtlsParameters: mediasoupTypes.DtlsParameters
  }, callback?: Function) => {
    try {
      const peer = peers.get(socket.id)
      const transport = peer?.transports.get(transportId)
      if (!transport) {
        vlog('connectTransport', `rejected: transport not found | transportId=${transportId}`)
        if (typeof callback === 'function') callback({ error: 'Transport not found' })
        return
      }
      const dir = (transport as any)._direction || '?'
      await connectTransport(transport, dtlsParameters)
      vlog('connectTransport', `ok | socketId=${socket.id} | dir=${dir} | transportId=${transportId}`)
      if (typeof callback === 'function') callback({ ok: true })
    } catch (err: any) {
      verr('connectTransport', `failed | transportId=${transportId}`, err)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:produce', async ({ channelId, transportId, kind, rtpParameters }: {
    channelId: string
    transportId: string
    kind: 'audio' | 'video'
    rtpParameters: mediasoupTypes.RtpParameters
  }, callback?: Function) => {
    try {
      const peer = peers.get(socket.id)
      const transport = peer?.transports.get(transportId)
      if (!peer || !transport) {
        vlog('produce', `rejected: transport not found | transportId=${transportId}`)
        if (typeof callback === 'function') callback({ error: 'Transport not found' })
        return
      }

      const producer = await produceOnTransport(transport, { kind, rtpParameters })
      peer.producers.set(producer.id, producer)
      vlog('produce', `created | socketId=${socket.id} | user=${peer.username} | kind=${kind} | producerId=${producer.id} | announced=${peer.announced}`)

      producer.on('transportclose', () => producer.close())

      if (!peer.announced) {
        peer.announced = true
        vlog('produce', `announcing new peer | socketId=${socket.id} | user=${peer.username} | channelPeers=${peers.size}`)
        socket.to(channelId).emit('voice:newPeer', {
          peerId: socket.id,
          userId: peer.userId,
          username: peer.username,
        })
        io.emit('voice:userJoinedChannel', {
          channelId,
          userId: peer.userId,
          username: peer.username,
        })
      }

      if (typeof callback === 'function') callback({ id: producer.id })
    } catch (err: any) {
      verr('produce', `failed | socketId=${socket.id}`, err)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:consume', async ({ channelId, peerId, rtpCapabilities, kind }: {
    channelId: string
    peerId: string
    rtpCapabilities: mediasoupTypes.RtpCapabilities
    kind?: 'audio' | 'video'
  }, callback?: Function) => {
    try {
      const requestingPeer = peers.get(socket.id)
      if (!requestingPeer) {
        if (typeof callback === 'function') callback({ error: 'Requesting peer not found' })
        return
      }

      let recvTransport = null
      for (const [, t] of requestingPeer.transports) {
        if ((t as any)._direction === 'recv') {
          recvTransport = t
          break
        }
      }
      if (!recvTransport) {
        vlog('consume', `rejected: no recv transport | socketId=${socket.id} | peerId=${peerId}`)
        if (typeof callback === 'function') callback({ error: 'Recv transport not found' })
        return
      }

      const targetPeer = peers.get(peerId)
      if (!targetPeer) {
        vlog('consume', `rejected: target peer not found | peerId=${peerId}`)
        if (typeof callback === 'function') callback({ error: 'Target peer not found' })
        return
      }

      const targetKind = kind || 'audio'
      let producerId = null
      for (const [id, producer] of targetPeer.producers) {
        if (producer.kind === targetKind) {
          producerId = id
          break
        }
      }
      if (!producerId) {
        vlog('consume', `rejected: no ${targetKind} producer | peerId=${peerId}`)
        if (typeof callback === 'function') callback({ error: `Target peer has no ${targetKind} producer` })
        return
      }

      if (!requestingPeer.router.canConsume({ producerId, rtpCapabilities })) {
        vlog('consume', `rejected: router cannot consume | producerId=${producerId}`)
        if (typeof callback === 'function') callback({ error: 'Router cannot consume this producer' })
        return
      }

      const consumer = await recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      })
      vlog('consume', `created | socketId=${socket.id} -> producerId=${producerId} | consumerId=${consumer.id} | kind=${consumer.kind} | paused=${consumer.producerPaused}`)

      requestingPeer.consumers.set(consumer.id, consumer)
      consumer.on('transportclose', () => consumer.close())
      consumer.on('producerclose', () => {
        consumer.close()
        socket.emit('voice:consumerClosed', { consumerId: consumer.id })
      })

      if (socketRtpEnabled.has(socket.id) && consumer.kind === 'audio') {
        const forwardingSocket = socket
        const forwardingPeerId = peerId
          consumer.on('rtp', (rtpPacket: Buffer) => {
            const hasExtension = (rtpPacket[0] & 0x10) !== 0
            const csrcCount = rtpPacket[0] & 0x0f
            let offset = 12 + csrcCount * 4
            if (hasExtension && offset + 4 <= rtpPacket.length) {
              const extLen = rtpPacket.readUInt16BE(offset + 2)
              offset += 4 + extLen * 4
            }
            const opusPayload = rtpPacket.subarray(offset)
            if (opusPayload.length > 0) {
              forwardingSocket.emit('voice:socketRtp', opusPayload, forwardingPeerId)
            }
          })
      }

      if (typeof callback === 'function') {
        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          paused: consumer.producerPaused,
        })
      }
    } catch (err: any) {
      verr('consume', `failed | peerId=${peerId}`, err)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:resumeConsumer', async ({ channelId, consumerId }: {
    channelId: string
    consumerId: string
  }, callback?: Function) => {
    try {
      const peer = peers.get(socket.id)
      const consumer = peer?.consumers.get(consumerId)
      if (consumer) {
        await consumer.resume()
        vlog('resumeConsumer', `ok | socketId=${socket.id} | consumerId=${consumerId}`)
      } else {
        vlog('resumeConsumer', `not found | socketId=${socket.id} | consumerId=${consumerId}`)
      }
      if (typeof callback === 'function') callback()
    } catch (err: any) {
      verr('resumeConsumer', `failed | consumerId=${consumerId}`, err)
      if (typeof callback === 'function') callback()
    }
  })

  socket.on('voice:speaking', ({ channelId, speaking }: {
    channelId: string
    speaking: boolean
  }) => {
    for (const [sid] of peers) {
      if (sid !== socket.id) {
        socket.to(sid).emit('voice:peerSpeaking', {
          peerId: socket.id,
          speaking,
        })
      }
    }
  })

  socket.on('voice:mute', ({ muted }: { muted: boolean }) => {
    const peer = peers.get(socket.id)
    if (!peer) return
    io.to(peer.channelId).emit('voice:mute', { userId: peer.userId, muted })
  })

  socket.on('screen:start', async ({ channelId }: { channelId: string }, callback?: Function) => {
    const peer = peers.get(socket.id)
    if (!peer) {
      if (typeof callback === 'function') callback({ error: 'Not in a voice channel' })
      return
    }
    const existing = getScreenSharer(channelId)
    if (existing && existing.peerId !== socket.id) {
      if (typeof callback === 'function') callback({ error: 'Someone else is already sharing' })
      return
    }
    let hasVideo = false
    for (const [, producer] of peer.producers) {
      if (producer.kind === 'video') { hasVideo = true; break }
    }
    if (!hasVideo) {
      if (typeof callback === 'function') callback({ error: 'No video producer found' })
      return
    }
    console.log(`[Screen] START | channel=${channelId} | user=${peer.username}`)
    socket.to(channelId).emit('screen:peerStarted', {
      peerId: socket.id,
      userId: peer.userId,
      username: peer.username,
    })
    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('screen:stop', ({ channelId }: { channelId: string }) => {
    const peer = peers.get(socket.id)
    if (!peer) return
    console.log(`[Screen] STOP | channel=${channelId} | user=${peer.username}`)
    io.to(channelId).emit('screen:peerStopped', { peerId: socket.id })
  })

  socket.on('voice:leave', async (payload?: { channelId?: string }) => {
    const channelId = payload?.channelId
    if (channelId) {
      cleanupPeer(socket.id, channelId, io)
    } else {
      for (const [sid, peer] of peers) {
        if (sid === socket.id) {
          cleanupPeer(socket.id, peer.channelId, io)
          break
        }
      }
    }
  })

  socket.on('voice:getOccupancy', (_, callback?: Function) => {
    const channels: Record<string, { userId: string; username: string }[]> = {}
    for (const [, peer] of peers) {
      if (!peer.announced) continue
      if (!channels[peer.channelId]) channels[peer.channelId] = []
      channels[peer.channelId].push({ userId: peer.userId, username: peer.username })
    }
    if (typeof callback === 'function') callback({ channels })
  })

  socket.on('voice:enableSocketRtp', () => {
    vlog('socketRtp', `enabled | socketId=${socket.id}`)
    socketRtpEnabled.add(socket.id)

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
        const forwardingSocket = socket
        const forwardingPeerId = producerPeerId
        consumer.on('rtp', (rtpPacket: Buffer) => {
          const hasExtension = (rtpPacket[0] & 0x10) !== 0
          const csrcCount = rtpPacket[0] & 0x0f
          let offset = 12 + csrcCount * 4
          if (hasExtension && offset + 4 <= rtpPacket.length) {
            const extLen = rtpPacket.readUInt16BE(offset + 2)
            offset += 4 + extLen * 4
          }
          const opusPayload = rtpPacket.subarray(offset)
          if (opusPayload.length > 0) {
            forwardingSocket.emit('voice:socketRtp', opusPayload, forwardingPeerId)
          }
        })
        count++
      }
      vlog('socketRtp', `registered ${count} existing consumers | socketId=${socket.id}`)
    }
  })

  socket.on('disconnect', async () => {
    socketRtpEnabled.delete(socket.id)
    for (const [sid, peer] of peers) {
      if (sid === socket.id) {
        vlog('disconnect', `socket disconnected | socketId=${socket.id} | user=${peer.username} | channelId=${peer.channelId}`)
        cleanupPeer(socket.id, peer.channelId, io)
        break
      }
    }
  })
}

function cleanupPeer(socketId: string, channelId: string, io: Server): void {
  const peer = peers.get(socketId)
  if (!peer) return

  let wasSharing = false
  let producerCount = 0
  for (const [, p] of peer.producers) {
    producerCount++
    if (p.kind === 'video') { wasSharing = true }
  }

  vlog('cleanup', `peer leaving | socketId=${socketId} | user=${peer.username} | channelId=${channelId} | producers=${producerCount} | consumers=${peer.consumers.size} | transports=${peer.transports.size} | wasSharing=${wasSharing} | remainingPeers=${peers.size - 1}`)

  peer.producers.forEach((p) => { try { p.close() } catch {} })
  peer.consumers.forEach((c) => { try { c.close() } catch {} })
  peer.transports.forEach((t) => { try { t.close() } catch {} })

  peers.delete(socketId)

  io.to(channelId).emit('voice:peerLeft', { peerId: socketId })
  io.emit('voice:userLeftChannel', { channelId, userId: peer.userId })
  if (wasSharing) {
    io.to(channelId).emit('screen:peerStopped', { peerId: socketId })
  }
}
