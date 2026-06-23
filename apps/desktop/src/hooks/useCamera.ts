import { useRef, useCallback, useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import type { Transport, Producer } from 'mediasoup-client/types'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'
import { isTauri } from '../utils/platform'

export function useCamera(
  socketRef: React.MutableRefObject<Socket | null>,
  sendTransportRef: React.MutableRefObject<Transport | null>,
) {
  const cameraProducerRef = useRef<Producer | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)

  const callStore = useCallStore

  const cleanupLocal = useCallback(() => {
    cameraProducerRef.current?.close()
    cameraProducerRef.current = null
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop())
    cameraStreamRef.current = null
    callStore.getState().setIsCameraOn(false)
    callStore.getState().setLocalCameraVideoProducerId(null)
  }, [])

  const startCamera = useCallback(async (channelId: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24 },
        },
      })
      cameraStreamRef.current = stream
      const videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) throw new Error('No video track')

      const sendTransport = sendTransportRef.current
      if (!sendTransport) throw new Error('Send transport not ready')

      const producer = await sendTransport.produce({
        track: videoTrack,
        encodings: [{ maxBitrate: 300000 }],
        codecOptions: {
          videoGoogleStartBitrate: 300,
        },
      })

      cameraProducerRef.current = producer
      callStore.getState().setIsCameraOn(true)
      callStore.getState().setLocalCameraVideoProducerId(producer.id)

      const socket = socketRef.current
      if (socket) {
        socket.emit('camera:started', { channelId, producerId: producer.id })
      }
    } catch (err) {
      console.error('Failed to start camera:', err)
      cleanupLocal()
    }
  }, [sendTransportRef, cleanupLocal])

  const stopCamera = useCallback((channelId: string) => {
    const socket = socketRef.current
    if (socket) {
      socket.emit('camera:stopped', { channelId })
    }
    cleanupLocal()
  }, [cleanupLocal])

  const toggleCamera = useCallback(async (channelId: string) => {
    if (cameraProducerRef.current) {
      stopCamera(channelId)
    } else {
      await startCamera(channelId)
    }
  }, [startCamera, stopCamera])

  const getStream = useCallback(() => cameraStreamRef.current, [])

  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId)

  useEffect(() => {
    if (!activeVoiceChannelId && cameraProducerRef.current) {
      cleanupLocal()
    }
  }, [activeVoiceChannelId, cleanupLocal])

  return { startCamera, stopCamera, toggleCamera, getStream, cameraStreamRef, cleanupLocal }
}
