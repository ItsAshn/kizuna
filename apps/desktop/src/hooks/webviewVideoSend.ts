import type { Socket } from 'socket.io-client'
import type { Device, Transport } from 'mediasoup-client/types'
import { useVoiceStore } from '../store/voiceStore'

/**
 * The webview video send transport of the native desktop client on Windows
 * and macOS. Audio goes out on the Rust transport; camera and screen are
 * produced from the webview, both on this one transport (purpose `video`), so
 * the client stays within the server's one-transport-per-purpose rule.
 *
 * Shared by useCamera and useScreenshare, created on first use and closed
 * when the call ends (useVoice's cleanup calls closeWebviewVideoSend).
 */
interface Shared {
  socket: Socket
  channelId: string
  device: Device
  transport: Transport
}

let shared: Shared | null = null
let pending: Promise<Shared> | null = null

async function create(socket: Socket, channelId: string): Promise<Shared> {
  const { routerRtpCapabilities, iceServers } = useVoiceStore.getState()
  if (!routerRtpCapabilities) throw new Error('Voice not joined — join a voice channel first')

  const { Device: DeviceClass } = await import('mediasoup-client')
  const device = new DeviceClass() as Device
  await device.load({ routerRtpCapabilities })

  const params: Record<string, unknown> = await new Promise((resolve) =>
    socket.emit(
      'voice:createTransport',
      { channelId, direction: 'send', purpose: 'video' },
      resolve,
    ),
  )
  if (params?.error) throw new Error(`Video transport failed: ${String(params.error)}`)

  const transport = device.createSendTransport({
    ...params,
    iceServers: iceServers.length > 0 ? iceServers : undefined,
  } as Parameters<Device['createSendTransport']>[0])

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
  transport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
    socket.emit(
      'voice:produce',
      {
        channelId,
        transportId: transport.id,
        kind,
        rtpParameters,
        source: (appData as { source?: 'camera' | 'screen' })?.source,
      },
      (res: { id?: string; error?: string } | undefined) => {
        if (res?.id) cb({ id: res.id })
        else errback(new Error(res?.error ?? 'produce failed'))
      },
    )
  })
  transport.on('connectionstatechange', (state) => {
    if (state === 'failed' || state === 'closed') {
      // Recreated on the next share/camera start.
      if (shared?.transport === transport) shared = null
    }
  })

  return { socket, channelId, device, transport }
}

export async function getWebviewVideoSend(socket: Socket, channelId: string): Promise<Transport> {
  if (shared && (shared.socket !== socket || shared.channelId !== channelId)) {
    closeWebviewVideoSend()
  }
  if (shared && !shared.transport.closed) return shared.transport
  if (!pending) {
    pending = create(socket, channelId).finally(() => {
      pending = null
    })
    shared = await pending
    return shared.transport
  }
  return (await pending).transport
}

export function closeWebviewVideoSend(): void {
  if (shared && !shared.transport.closed) shared.transport.close()
  shared = null
}
