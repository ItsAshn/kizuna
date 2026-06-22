import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import type { UserActivity } from '@kizuna/shared'

function detectActivity(metadata: { title?: string; artist?: string; album?: string } | null): UserActivity | null {
  if (!metadata) return null

  const title = metadata.title || ''
  const artist = metadata.artist || ''
  const album = metadata.album || ''

  if (!title) return null

  let type: UserActivity['type'] = 'other'
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

export function useActivityDetector(socketRef: React.MutableRefObject<any>) {
  const shareMediaActivity = useSettingsStore((s) => s.shareMediaActivity)
  const shareActivity = useSettingsStore((s) => s.shareActivity)
  const lastActivityRef = useRef<string | null>(null)

  useEffect(() => {
    if (!shareActivity || !shareMediaActivity) return

    const socket = socketRef.current
    if (!socket) return

    function emitActivity(activity: UserActivity | null) {
      const json = activity ? JSON.stringify(activity) : null
      if (json === lastActivityRef.current) return
      lastActivityRef.current = json
      socket.emit('user:activity', { activity })
    }

    function checkMedia() {
      if ('mediaSession' in navigator) {
        const metadata = navigator.mediaSession.metadata
        const activity = detectActivity(metadata)
        emitActivity(activity)
      }
    }

    checkMedia()
    const interval = setInterval(checkMedia, 5000)

    return () => {
      clearInterval(interval)
      if (socket.connected) {
        emitActivity(null)
      }
    }
  }, [shareActivity, shareMediaActivity])

  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return

    if (!shareActivity) {
      socket.emit('user:activity', { activity: null })
      lastActivityRef.current = null
    }
  }, [shareActivity])
}
