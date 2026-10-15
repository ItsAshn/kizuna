import { useEffect, useRef } from 'react'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { useChatStore } from '../store/chatStore'
import { isMobileTauri } from '../utils/platform'

interface CallServiceArgs {
  [key: string]: unknown
  title: string
  text: string
  camera: boolean
}

async function callService(command: 'start' | 'update' | 'stop', args?: CallServiceArgs) {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke(`plugin:call-service|${command}`, args)
}

/**
 * Android only: run the call-service plugin's foreground service for as long
 * as a voice call is up. Without it Android stops capturing the microphone
 * once the app is in the background, and may stop the app outright, so the
 * call dies when the screen turns off.
 *
 * The service starts when a join succeeds (`activeVoiceChannelId` is set) and
 * stops when the call ends. A transport reconnect keeps `activeVoiceChannelId`
 * and so keeps the service, which matters: Android 12+ refuses to start a
 * foreground service from the background, so it could not come back. The
 * camera adds the `camera` service type while it is on.
 */
export function useCallForegroundService(leaveVoice: () => unknown) {
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId)
  const isCameraOn = useCallStore((s) => s.isCameraOn)
  const dmCallOtherUsername = useCallStore((s) => s.dmCallOtherUsername)
  const channelName = useChatStore((s) =>
    activeVoiceChannelId ? s.channels.find((c) => c.id === activeVoiceChannelId)?.name : undefined,
  )
  const runningRef = useRef(false)
  const leaveRef = useRef(leaveVoice)

  useEffect(() => {
    leaveRef.current = leaveVoice
  }, [leaveVoice])

  useEffect(() => {
    if (!isMobileTauri()) return
    if (!activeVoiceChannelId) {
      if (runningRef.current) {
        runningRef.current = false
        callService('stop').catch((err) => console.warn('[call-service] stop failed:', err))
      }
      return
    }

    const args: CallServiceArgs = {
      title: 'In a voice call',
      text: dmCallOtherUsername
        ? `Call with ${dmCallOtherUsername}`
        : channelName
          ? `Connected to ${channelName}`
          : 'Tap to return to the call',
      camera: isCameraOn,
    }
    // Only the first call may prompt for the notification permission; camera
    // and title changes refresh the running service quietly.
    const command = runningRef.current ? 'update' : 'start'
    runningRef.current = true
    callService(command, args).catch((err) =>
      console.warn(`[call-service] ${command} failed:`, err),
    )
  }, [activeVoiceChannelId, isCameraOn, dmCallOtherUsername, channelName])

  // The notification's "Leave call" action.
  useEffect(() => {
    if (!isMobileTauri()) return
    let cancelled = false
    let unregister: (() => void) | null = null
    import('@tauri-apps/api/core')
      .then(({ addPluginListener }) =>
        addPluginListener('call-service', 'leave', () => {
          void leaveRef.current()
        }),
      )
      .then((listener) => {
        if (cancelled) void listener.unregister()
        else unregister = () => void listener.unregister()
      })
      .catch((err) => console.warn('[call-service] leave listener failed:', err))
    return () => {
      cancelled = true
      unregister?.()
    }
  }, [])

  // Leaving the chat route (logout) ends any call, so the service goes too.
  useEffect(
    () => () => {
      if (runningRef.current) {
        runningRef.current = false
        callService('stop').catch(() => {})
      }
    },
    [],
  )
}
