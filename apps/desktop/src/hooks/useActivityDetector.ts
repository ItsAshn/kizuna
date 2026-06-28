import { useEffect, useRef, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import { useSettingsStore } from '../store/settingsStore'

import { isTauri } from '../utils/platform'
import type { UserActivity, UserActivityType } from '@kizuna/shared'

const SWITCH_DELAY_MS = 10_000

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
let invokePromise: Promise<InvokeFn> | null = null
function getInvoke(): Promise<InvokeFn> {
  if (!invokePromise) {
    invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke as InvokeFn)
  }
  return invokePromise
}

// Minimal set of processes that should never show as user activity.
const SUPPRESSED_APPS = new Set([
  'keepassxc', 'keepass', 'bitwarden', '1password',
  'hyprlock', 'swaylock', 'i3lock', 'gtklock',
  'kizuna', 'kizuna-desktop', 'com.kizuna.desktop',
  'plasmashell', 'gnome-shell',
])

function isSuppressedApp(processName: string): boolean {
  return SUPPRESSED_APPS.has(processName.toLowerCase())
}

function detectMediaActivity(metadata: {
  title?: string
  artist?: string
  album?: string
} | null): UserActivity | null {
  if (!metadata) return null

  const title = metadata.title?.trim() || ''
  const artist = metadata.artist?.trim() || ''
  const album = metadata.album?.trim() || ''

  if (!title) return null

  let type: UserActivityType = 'other'
  if (artist && album) {
    type = 'music'
  } else if (title) {
    type = 'video'
  }

  const activity: UserActivity = { type, name: title }
  if (artist) activity.details = artist
  if (album) activity.state = album

  return activity
}

export function useActivityDetector(socketRef: React.MutableRefObject<Socket | null>) {
  const shareMediaActivity = useSettingsStore((s) => s.shareMediaActivity)
  const shareAppActivity = useSettingsStore((s) => s.shareAppActivity)
  const customMediaActivity = useSettingsStore((s) => s.customMediaActivity)
  const customAppActivity = useSettingsStore((s) => s.customAppActivity)
  const addRecentMediaActivity = useSettingsStore((s) => s.addRecentMediaActivity)
  const addRecentAppActivity = useSettingsStore((s) => s.addRecentAppActivity)

  const lastEmittedRef = useRef<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stableWindowKeyRef = useRef<string | null>(null)
  const windowFirstSeenRef = useRef<number>(0)
  const lastRecentAppRef = useRef<string | null>(null)
  const lastRecentMediaRef = useRef<string | null>(null)
  const trackedGameRef = useRef<{ processName: string; title: string } | null>(null)

  const emitActivity = useCallback(
    (activity: UserActivity | null) => {
      const socket = socketRef.current
      if (!socket?.connected) return
      const json = activity ? JSON.stringify(activity) : null
      if (json === lastEmittedRef.current) return
      lastEmittedRef.current = json
      socket.emit('user:activity', { activity })
    },
    [socketRef],
  )

  const clearActivity = useCallback(() => {
    const socket = socketRef.current
    if (socket?.connected) {
      socket.emit('user:activity', { activity: null })
    }
    lastEmittedRef.current = null
    stableWindowKeyRef.current = null
    windowFirstSeenRef.current = 0
    trackedGameRef.current = null
  }, [socketRef])

  const resolveActivity = useCallback((): UserActivity | null => {
    if (shareAppActivity && customAppActivity) {
      return { type: 'other', name: customAppActivity }
    }
    if (shareMediaActivity && customMediaActivity) {
      return { type: 'other', name: customMediaActivity }
    }
    return null
  }, [
    shareAppActivity,
    shareMediaActivity,
    customAppActivity,
    customMediaActivity,
  ])

  useEffect(() => {
    if (!shareMediaActivity && !shareAppActivity) return

    const socket = socketRef.current
    if (!socket) return

    const tick = async () => {
      const customActivity = resolveActivity()
      if (customActivity) {
        emitActivity(customActivity)
        return
      }

      let bestActivity: UserActivity | null = null
      let musicActivity: UserActivity | null = null

      if (shareAppActivity && isTauri()) {
        try {
          const invoke = await getInvoke()
          const details = await invoke<{
            title: string
            process_name: string
            display_name: string
            category: 'game' | 'app'
            icon?: string
          } | null>('get_active_window_details')

          if (details && details.title) {
            if (isSuppressedApp(details.process_name)) {
              stableWindowKeyRef.current = null
              windowFirstSeenRef.current = 0
            } else {
              const windowKey = details.process_name + '\x00' + details.title

              if (windowKey === stableWindowKeyRef.current) {
                const elapsed = Date.now() - windowFirstSeenRef.current
                if (elapsed >= SWITCH_DELAY_MS) {
                  const isGame = details.category === 'game'
                  const type: UserActivityType = isGame ? 'game' : 'app'
                  const name = isGame
                    ? details.title.trim()
                    : details.display_name

                  bestActivity = {
                    type,
                    name,
                    details: !isGame ? details.process_name || undefined : undefined,
                    icon: !isGame ? details.icon : undefined,
                  }

                  if (isGame) {
                    trackedGameRef.current = {
                      processName: details.process_name,
                      title: name,
                    }
                  }

                  if (!isGame && name !== lastRecentAppRef.current) {
                    addRecentAppActivity(name)
                    lastRecentAppRef.current = name
                  }
                }
              } else {
                stableWindowKeyRef.current = windowKey
                windowFirstSeenRef.current = Date.now()
              }
            }
          } else {
            stableWindowKeyRef.current = null
            windowFirstSeenRef.current = 0
          }
        } catch (err) {
          console.warn('useActivityDetector: get_active_window_details failed', err)
        }
      }

      if (shareMediaActivity) {
        if (isTauri()) {
          try {
            const invoke = await getInvoke()
            const np = await invoke<{
              title: string
              artist: string
              album: string
              status: string
            } | null>('get_now_playing')
            if (np && np.status === 'Playing') {
              const activity = detectMediaActivity(np)
              if (activity) {
                if (activity.name !== lastRecentMediaRef.current) {
                  addRecentMediaActivity(activity.name)
                  lastRecentMediaRef.current = activity.name
                }
                musicActivity = activity
              }
            }
          } catch (err) {
            console.warn('useActivityDetector: get_now_playing failed', err)
          }
        }

        if (!musicActivity && 'mediaSession' in navigator) {
          const metadata = navigator.mediaSession.metadata
          const activity = detectMediaActivity(metadata)
          if (activity) {
            addRecentMediaActivity(activity.name)
            musicActivity = activity
          }
        }
      }

      // ── Tracked game persistence ──
      if (trackedGameRef.current && (!bestActivity || bestActivity.type !== 'game')) {
        try {
          const invoke = await getInvoke()
          const windows = await invoke<Array<{ process_name: string }>>('list_windows')
          const procName = trackedGameRef.current.processName.toLowerCase()
          const stillRunning = windows.some((w) => w.process_name.toLowerCase() === procName)
          if (stillRunning) {
            bestActivity = {
              type: 'game',
              name: trackedGameRef.current.title,
            }
          } else {
            trackedGameRef.current = null
          }
        } catch {
          trackedGameRef.current = null
        }
      }

      if (bestActivity && bestActivity.type === 'game') {
        emitActivity(bestActivity)
      } else if (musicActivity) {
        emitActivity(musicActivity)
      } else if (bestActivity) {
        emitActivity(bestActivity)
      } else {
        emitActivity(null)
      }
    }

    tick()
    intervalRef.current = setInterval(tick, 5000)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [
    shareMediaActivity,
    shareAppActivity,
    customAppActivity,
    customMediaActivity,
    resolveActivity,
    emitActivity,
    addRecentMediaActivity,
    addRecentAppActivity,
    socketRef,
  ])

  useEffect(() => {
    if (shareMediaActivity || shareAppActivity) return
    clearActivity()
  }, [shareMediaActivity, shareAppActivity, clearActivity])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return

    const onConnect = () => {
      if (shareMediaActivity || shareAppActivity) {
        lastEmittedRef.current = null
        stableWindowKeyRef.current = null
        windowFirstSeenRef.current = 0
        trackedGameRef.current = null
        const customActivity = resolveActivity()
        if (customActivity) {
          emitActivity(customActivity)
        }
      }
    }

    socket.on('connect', onConnect)
    return () => {
      socket.off('connect', onConnect)
    }
  }, [
    socketRef,
    shareMediaActivity,
    shareAppActivity,
    resolveActivity,
    emitActivity,
  ])
}
