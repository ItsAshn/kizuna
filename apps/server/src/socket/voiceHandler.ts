import type { Server, Socket } from 'socket.io'
import { ensureRouter, createTransport, connectTransport, produceOnTransport, consumeOnTransport } from '../media/router'
import type { types as mediasoupTypes } from 'mediasoup'
import jwt from 'jsonwebtoken'

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

interface PeerInfo {
  socketId: string
  userId: string
  username: string
  channelId: string
  router: mediasoupTypes.Router
  transports: Map<string, (mediasoupTypes.WebRtcTransport & { _direction?: string })>
  producers: Map<string, mediasoupTypes.Producer>
  consumers: Map<string, mediasoupTypes.Consumer>
  announced: boolean
}

const peers = new Map<string, PeerInfo>()

export function getPeersInChannel(channelId: string): PeerInfo[] {
  const result: PeerInfo[] = []
  for (const peer of peers.values()) {
    if (peer.channelId === channelId) result.push(peer)
  }
  return result
}

export function registerVoiceHandlers(io: Server, socket: Socket): void {
  socket.on('voice:join', async ({ channelId, userId, username }: {
    channelId: string
    userId: string
    username: string
  }, callback?: Function) => {
    try {
      const token = socket.handshake?.auth?.token
      if (!token) {
        if (typeof callback === 'function') callback({ error: 'Authentication required' })
        return
      }
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET!) as { id: string; username: string }
        userId = payload.id
        username = payload.username
      } catch {
        if (typeof callback === 'function') callback({ error: 'Invalid or expired token' })
        return
      }

      const router = await ensureRouter(channelId)

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

      if (typeof callback === 'function') {
        callback({
          routerRtpCapabilities: router.rtpCapabilities,
          peers: channelPeers,
          iceServers: getIceServers(),
        })
      }
    } catch (err: any) {
      console.error('[Voice] join error:', err.message)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:createTransport', async ({ channelId, direction }: {
    channelId: string
    direction: string
  }, callback?: Function) => {
    try {
      const peer = peers.get(socket.id)
      if (!peer) {
        if (typeof callback === 'function') callback({ error: 'Not in a voice channel' })
        return
      }

      const transport = await createTransport(peer.router);
      (transport as any)._direction = direction
      peer.transports.set(transport.id, transport as any)

      transport.on('dtlsstatechange', (state: string) => {
        if (state === 'failed' || state === 'closed') {
          console.warn(`[Voice] transport dtls=${state} | dir=${direction} | peer=${socket.id}`)
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
      console.error('[Voice] createTransport error:', err.message)
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
        if (typeof callback === 'function') callback({ error: 'Transport not found' })
        return
      }
      await connectTransport(transport, dtlsParameters)
      if (typeof callback === 'function') callback({ ok: true })
    } catch (err: any) {
      console.error('[Voice] connectTransport error:', err.message)
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
        if (typeof callback === 'function') callback({ error: 'Transport not found' })
        return
      }

      const producer = await produceOnTransport(transport, { kind, rtpParameters })
      peer.producers.set(producer.id, producer)

      producer.on('transportclose', () => producer.close())

      if (!peer.announced) {
        peer.announced = true
        console.log(`[Voice] PRODUCE | channel=${channelId} | user=${peer.username} | kind=${kind}`)
        socket.to(channelId).emit('voice:newPeer', {
          peerId: socket.id,
          userId: peer.userId,
          username: peer.username,
        })
      }

      if (typeof callback === 'function') callback({ id: producer.id })
    } catch (err: any) {
      console.error('[Voice] produce error:', err.message)
      if (typeof callback === 'function') callback({ error: err.message })
    }
  })

  socket.on('voice:consume', async ({ channelId, peerId, rtpCapabilities }: {
    channelId: string
    peerId: string
    rtpCapabilities: mediasoupTypes.RtpCapabilities
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
        if (typeof callback === 'function') callback({ error: 'Recv transport not found' })
        return
      }

      const targetPeer = peers.get(peerId)
      if (!targetPeer) {
        if (typeof callback === 'function') callback({ error: 'Target peer not found' })
        return
      }

      let producerId = null
      for (const [id, producer] of targetPeer.producers) {
        if (producer.kind === 'audio') {
          producerId = id
          break
        }
      }
      if (!producerId) {
        if (typeof callback === 'function') callback({ error: 'Target peer has no audio producer' })
        return
      }

      if (!requestingPeer.router.canConsume({ producerId, rtpCapabilities })) {
        if (typeof callback === 'function') callback({ error: 'Router cannot consume this producer' })
        return
      }

      const consumer = await recvTransport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      })

      requestingPeer.consumers.set(consumer.id, consumer)
      consumer.on('transportclose', () => consumer.close())
      consumer.on('producerclose', () => {
        consumer.close()
        socket.emit('voice:consumerClosed', { consumerId: consumer.id })
      })

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
      console.error('[Voice] consume error:', err.message)
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
      }
      if (typeof callback === 'function') callback()
    } catch (err: any) {
      console.error('[Voice] resumeConsumer error:', err.message)
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

  socket.on('voice:setBitrate', async ({ channelId, transportId, maxBitrateKbps }: {
    channelId: string
    transportId: string
    maxBitrateKbps: number
  }) => {
    try {
      const peer = peers.get(socket.id)
      const transport = peer?.transports.get(transportId)
      if (!transport) return
      const bps = Math.max(8000, Math.min(512000, maxBitrateKbps * 1000))
      await transport.setMaxIncomingBitrate(bps)
    } catch (err: any) {
      console.error('[Voice] setBitrate error:', err.message)
    }
  })

  socket.on('voice:mute', ({ muted }: { muted: boolean }) => {
    const peer = peers.get(socket.id)
    if (!peer) return
    io.to(peer.channelId).emit('voice:mute', { userId: peer.userId, muted })
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

  socket.on('disconnect', async () => {
    for (const [sid, peer] of peers) {
      if (sid === socket.id) {
        cleanupPeer(socket.id, peer.channelId, io)
        break
      }
    }
  })
}

function cleanupPeer(socketId: string, channelId: string, io: Server): void {
  const peer = peers.get(socketId)
  if (!peer) return

  console.log(`[Voice] LEFT | channel=${channelId} | user=${peer.username}`)

  peer.producers.forEach((p) => { try { p.close() } catch {} })
  peer.consumers.forEach((c) => { try { c.close() } catch {} })
  peer.transports.forEach((t) => { try { t.close() } catch {} })

  peers.delete(socketId)

  io.to(channelId).emit('voice:peerLeft', { peerId: socketId })
}
