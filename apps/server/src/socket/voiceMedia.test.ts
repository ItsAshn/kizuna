import { describe, expect, it } from 'vitest'
import {
  closeVideoProducers,
  defaultPurpose,
  findScreenSharer,
  findVideoProducer,
  maxIncomingBitrateBps,
  pickRecvTransport,
  planTransportSlot,
  type PeerMediaLike,
  type ProducerLike,
  type TransportSlot,
} from './voiceMedia'

class FakeProducer implements ProducerLike {
  closed = false
  private readonly onClose: Array<() => void> = []
  constructor(
    public id: string,
    public kind: 'audio' | 'video',
    public appData: { source?: unknown } = {},
  ) {}
  /** Mirrors `producer.observer.once('close', ...)` in voiceHandler. */
  observeClose(fn: () => void) {
    this.onClose.push(fn)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const fn of this.onClose) fn()
  }
}

function peerWith(socketId: string, ...producers: FakeProducer[]) {
  const map = new Map<string, FakeProducer>()
  for (const p of producers) {
    map.set(p.id, p)
    p.observeClose(() => map.delete(p.id))
  }
  const peer: PeerMediaLike & { producers: Map<string, FakeProducer> } = {
    socketId,
    userId: `u-${socketId}`,
    username: `name-${socketId}`,
    producers: map,
  }
  return peer
}

describe('screen sharer bookkeeping', () => {
  it('finds the sharer and its producer id', () => {
    const a = peerWith('a', new FakeProducer('a-mic', 'audio'))
    const b = peerWith(
      'b',
      new FakeProducer('b-mic', 'audio'),
      new FakeProducer('b-screen', 'video', { source: 'screen' }),
    )
    expect(findScreenSharer([a, b])).toEqual({
      peerId: 'b',
      userId: 'u-b',
      username: 'name-b',
      producerId: 'b-screen',
    })
  })

  it('does not treat a camera as a screenshare', () => {
    const a = peerWith('a', new FakeProducer('a-cam', 'video', { source: 'camera' }))
    expect(findScreenSharer([a])).toBeNull()
  })

  it('treats untagged video from older clients as screen', () => {
    const a = peerWith('a', new FakeProducer('a-vid', 'video'))
    expect(findScreenSharer([a])?.producerId).toBe('a-vid')
  })

  it('returns null after screen:stop closes the producer', () => {
    const b = peerWith(
      'b',
      new FakeProducer('b-mic', 'audio'),
      new FakeProducer('b-screen', 'video', { source: 'screen' }),
      new FakeProducer('b-cam', 'video', { source: 'camera' }),
    )
    expect(closeVideoProducers(b.producers, 'screen')).toEqual(['b-screen'])
    expect(findScreenSharer([b])).toBeNull()
    // The rest of the peer's media is untouched.
    expect([...b.producers.keys()].sort()).toEqual(['b-cam', 'b-mic'])
  })

  it('lets another peer share once the first one stopped', () => {
    const a = peerWith('a', new FakeProducer('a-screen', 'video', { source: 'screen' }))
    const b = peerWith('b')
    closeVideoProducers(a.producers, 'screen')
    const next = new FakeProducer('b-screen', 'video', { source: 'screen' })
    b.producers.set(next.id, next)
    expect(findScreenSharer([a, b])?.peerId).toBe('b')
  })

  it('ignores a closed producer the map still holds', () => {
    const p = new FakeProducer('x', 'video', { source: 'screen' })
    const peer = peerWith('a')
    peer.producers.set(p.id, p)
    p.closed = true
    expect(findScreenSharer([peer])).toBeNull()
  })

  it('camera:stopped closes only the camera', () => {
    const a = peerWith(
      'a',
      new FakeProducer('a-screen', 'video', { source: 'screen' }),
      new FakeProducer('a-cam', 'video', { source: 'camera' }),
    )
    expect(closeVideoProducers(a.producers, 'camera')).toEqual(['a-cam'])
    expect(findVideoProducer(a.producers.values(), 'camera')).toBeNull()
    expect(findVideoProducer(a.producers.values(), 'screen')?.id).toBe('a-screen')
  })
})

describe('recv transport choice for voice:consume', () => {
  const linuxNative: TransportSlot[] = [
    { id: 'send', direction: 'send', purpose: 'av' },
    { id: 'direct', direction: 'recv', purpose: 'audio' },
    { id: 'video', direction: 'recv', purpose: 'video' },
  ]

  it('uses the transport the client names', () => {
    expect(pickRecvTransport(linuxNative, 'video', 'video')?.id).toBe('video')
    expect(pickRecvTransport(linuxNative, 'audio', 'direct')?.id).toBe('direct')
  })

  it('rejects a named transport that is not one of the peer recv transports', () => {
    expect(pickRecvTransport(linuxNative, 'video', 'send')).toBeNull()
    expect(pickRecvTransport(linuxNative, 'video', 'nope')).toBeNull()
  })

  it('rejects a named transport that already closed', () => {
    const t: TransportSlot[] = [{ id: 'video', direction: 'recv', purpose: 'video', closed: true }]
    expect(pickRecvTransport(t, 'video', 'video')).toBeNull()
  })

  it('never lands video on the audio DirectTransport by default', () => {
    expect(pickRecvTransport(linuxNative, 'video')?.id).toBe('video')
    const audioOnly: TransportSlot[] = [{ id: 'direct', direction: 'recv', purpose: 'audio' }]
    expect(pickRecvTransport(audioOnly, 'video')).toBeNull()
  })

  it('sends audio to the audio transport, and browsers to their single av recv', () => {
    expect(pickRecvTransport(linuxNative, 'audio')?.id).toBe('direct')
    const browser: TransportSlot[] = [
      { id: 's', direction: 'send', purpose: 'av' },
      { id: 'r', direction: 'recv', purpose: 'av' },
    ]
    expect(pickRecvTransport(browser, 'audio')?.id).toBe('r')
    expect(pickRecvTransport(browser, 'video')?.id).toBe('r')
  })
})

describe('transport slots', () => {
  it('lets the Windows/macOS client hold all four of its transports', () => {
    const held: TransportSlot[] = []
    const add = (id: string, direction: 'send' | 'recv', purpose: TransportSlot['purpose']) => {
      const plan = planTransportSlot(held, direction, purpose)
      expect(plan).toEqual({ replace: [], error: null })
      held.push({ id, direction, purpose })
    }
    add('audio-send', 'send', 'audio')
    add('direct', 'recv', 'audio')
    add('video-send', 'send', 'video')
    add('video-recv', 'recv', 'video')
  })

  it('replaces only the transport in the same (direction, purpose) slot', () => {
    const held: TransportSlot[] = [
      { id: 'send', direction: 'send', purpose: 'av' },
      { id: 'direct', direction: 'recv', purpose: 'audio' },
      { id: 'video', direction: 'recv', purpose: 'video' },
    ]
    expect(planTransportSlot(held, 'recv', 'video')).toEqual({ replace: ['video'], error: null })
    expect(planTransportSlot(held, 'recv', 'audio')).toEqual({ replace: ['direct'], error: null })
  })

  it('refuses a fifth transport', () => {
    const held: TransportSlot[] = [
      { id: '1', direction: 'send', purpose: 'audio' },
      { id: '2', direction: 'recv', purpose: 'audio' },
      { id: '3', direction: 'send', purpose: 'video' },
      { id: '4', direction: 'recv', purpose: 'video' },
    ]
    expect(planTransportSlot(held, 'send', 'av').error).toBe('Too many transports')
    // ...but a replacement is always allowed.
    expect(planTransportSlot(held, 'send', 'video').error).toBeNull()
  })

  it('does not count closed transports', () => {
    const held: TransportSlot[] = [
      { id: '1', direction: 'send', purpose: 'audio', closed: true },
      { id: '2', direction: 'recv', purpose: 'audio', closed: true },
      { id: '3', direction: 'send', purpose: 'video', closed: true },
      { id: '4', direction: 'recv', purpose: 'video', closed: true },
    ]
    expect(planTransportSlot(held, 'send', 'av')).toEqual({ replace: [], error: null })
  })

  it('keeps old clients working when they send no purpose', () => {
    expect(defaultPurpose('send', [])).toBe('av')
    expect(defaultPurpose('recv', [])).toBe('av')
    // An old client's second send transport is its camera/screen one.
    const withMain: TransportSlot[] = [{ id: 's', direction: 'send', purpose: 'av' }]
    expect(defaultPurpose('send', withMain)).toBe('video')
  })

  it('caps audio transports at the voice bitrate and video ones in megabits', () => {
    expect(maxIncomingBitrateBps('audio', 64)).toBe(64_000)
    expect(maxIncomingBitrateBps('av', 64)).toBeGreaterThan(4_000_000)
    expect(maxIncomingBitrateBps('video', 64)).toBeGreaterThan(4_000_000)
  })
})
