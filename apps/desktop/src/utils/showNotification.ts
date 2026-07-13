import { useNotificationStore } from '../store/notificationStore'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import { useSettingsStore } from '../store/settingsStore'
import type { NotificationLevel } from '../store/settingsStore'
import { isTauri } from './platform'

interface ShowNotificationOptions {
  type: 'announce' | 'mention' | 'message' | 'dmcall'
  title: string
  body: string
  channelId?: string
}

let audioCtx: AudioContext | null = null

function playNotificationSound() {
  const enabled = useSettingsStore.getState().notificationSoundEnabled
  if (!enabled) return

  try {
    if (!audioCtx) audioCtx = new AudioContext()
    const ctx = audioCtx

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = 'sine'
    gain.gain.setValueAtTime(0.12, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3)

    osc.frequency.setValueAtTime(880, now)
    osc.frequency.setValueAtTime(1100, now + 0.08)
    osc.frequency.setValueAtTime(1320, now + 0.16)

    osc.start(now)
    osc.stop(now + 0.3)
  } catch { /* AudioContext not available */ }
}

export async function ensureNotificationPermission(): Promise<void> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
      if (!(await isPermissionGranted())) await requestPermission()
    } catch { /* plugin unavailable */ }
    return
  }
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function sendOSNotification(title: string, body: string, tag: string) {
  if (isTauri()) {
    import('@tauri-apps/plugin-notification')
      .then(async ({ isPermissionGranted, sendNotification }) => {
        if (await isPermissionGranted()) sendNotification({ title, body })
      })
      .catch(() => { /* plugin unavailable */ })
    return
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, icon: '/Logo.webp', tag })
    } catch { /* not supported */ }
  }
}

export function showNotification(opts: ShowNotificationOptions) {
  if (opts.channelId && opts.type !== 'announce' && opts.type !== 'dmcall') {
    const mutes = useChatStore.getState().channelMutes
    const mute = mutes[opts.channelId]
    if (mute !== undefined) {
      if (mute === null) return
      if (typeof mute === 'number' && mute > Date.now()) return
    }

    const overrides = useSettingsStore.getState().channelNotificationLevels
    const override = overrides[opts.channelId]
    if (override === 'none') return

    const serverId = useServerStore.getState().activeSession?.serverId
    if (serverId) {
      const notif = useSettingsStore.getState().notificationSettings[serverId]
      const effectiveLevel = (override ?? notif?.level ?? 'all') as NotificationLevel
      if (effectiveLevel === 'none') return
      if (effectiveLevel === 'mentions' && opts.type !== 'mention') return
    }
  }

  playNotificationSound()

  useNotificationStore.getState().addNotification({
    type: opts.type,
    title: opts.title,
    body: opts.body,
    channelId: opts.channelId,
  })

  const tag = opts.type === 'mention' ? `mention-${opts.channelId}` :
              opts.type === 'announce' ? 'announce' :
              opts.type === 'dmcall' ? 'dmcall' :
              `message-${opts.channelId ?? 'unknown'}`

  sendOSNotification(opts.title, opts.body, tag)
}

export function showErrorToast(context: string) {
  useNotificationStore.getState().addNotification({
    type: 'message',
    title: 'Error',
    body: `Failed to ${context}. Please try again.`,
  })
}
