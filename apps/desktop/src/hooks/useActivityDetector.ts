import { useEffect, useRef, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import { useSettingsStore } from '../store/settingsStore'

import { isTauri } from '../utils/platform'
import type { UserActivity, UserActivityType } from '@kizuna/shared'

const KNOWN_GAMES = new Set([
  'cs2.exe', 'csgo.exe', 'cs2',
  'valorant.exe', 'valorant',
  'league of legends.exe', 'leagueclient.exe', 'league of legends',
  'dota2.exe', 'dota2',
  'overwatch.exe', 'overwatch',
  'minecraft.exe', 'minecraft',
  'fortnite.exe', 'fortniteclient-win64-shipping.exe', 'fortnite',
  'apex legends.exe', 'r5apex.exe', 'apex legends',
  'rainbow six.exe', 'rainbowsix.exe', 'tom clancy\'s rainbow six siege',
  'pubg.exe', 'tslgame.exe', 'pubg',
  'rust.exe', 'rust',
  'gta5.exe', 'grand theft auto v',
  'rocket league.exe', 'rocket league',
  'destiny2.exe', 'destiny 2',
  'warframe.x64.exe', 'warframe',
  'osu!.exe', 'osu!',
  'terraria.exe', 'terraria',
  'factorio.exe', 'factorio',
  'stardew valley.exe', 'stardew valley',
  'elden ring.exe', 'elden ring',
  'baldur\'s gate 3.exe', 'bg3.exe', 'baldur\'s gate 3',
  'cyberpunk 2077.exe', 'cyberpunk 2077',
  'genshinimpact.exe', 'genshin impact',
  'steam', 'steam.exe',
  'discord.exe', 'discord',
  'spotify.exe', 'spotify',
  'chrome.exe', 'google chrome',
  'firefox.exe', 'firefox',
  'code.exe', 'visual studio code',
  'hl2.exe', 'half-life 2',
  'left4dead2.exe', 'left 4 dead 2',
  'tf2.exe', 'team fortress 2',
  'portal2.exe', 'portal 2',
  'rimworld.exe', 'rimworld',
  'stellaris.exe', 'stellaris',
  'crusader kings iii.exe', 'crusader kings iii',
  'civilization vi.exe', 'civilization vi',
  'witcher3.exe', 'the witcher 3',
  'monster hunter world.exe', 'monster hunter world',
  'monster hunter rise.exe', 'monster hunter rise',
  'dead cells.exe', 'dead cells',
  'hollow knight.exe', 'hollow knight',
  'hades.exe', 'hades',
  'subnautica.exe', 'subnautica',
  'slay the spire.exe', 'slay the spire',
  'darkest dungeon.exe', 'darkest dungeon',
  'celeste.exe', 'celeste',
  'cuphead.exe', 'cuphead',
  'doom eternal.exe', 'doom eternal',
  'battlefield 2042.exe', 'bf2042.exe',
  'call of duty.exe', 'cod.exe', 'modern warfare.exe',
  'world of warcraft.exe', 'wow.exe', 'wowclassic.exe',
  'final fantasy xiv.exe', 'ffxiv.exe', 'ffxiv_dx11.exe',
  'path of exile.exe', 'pathofexile.exe', 'pathofexile_x64.exe',
  'escape from tarkov.exe', 'escapefromtarkov.exe',
  'dead by daylight.exe', 'deadbydaylight.exe',
  'phasmophobia.exe', 'phasmophobia',
  'valheim.exe', 'valheim',
  'v rising.exe', 'v rising',
  'satisfactory.exe', 'satisfactory',
  'deep rock galactic.exe', 'deep rock galactic',
  'risk of rain 2.exe', 'risk of rain 2',
  'hearthstone.exe', 'hearthstone',
  'magic the gathering arena.exe', 'mtga.exe',
  'brawlhalla.exe', 'brawlhalla',
  'smite.exe', 'smite',
  'palworld.exe', 'palworld',
  'helldivers 2.exe', 'helldivers2.exe',
  'balatro.exe', 'balatro',
  'starfield.exe', 'starfield',
  'lies of p.exe', 'lies of p',
  'both worlds.exe', 'both worlds',
  'war thunder.exe', 'warthunder',
  'world of tanks.exe', 'worldoftanks',
  'counter-strike 2', 'Counter-Strike 2',
  'left 4 dead 2',
])

function isGameApp(appName: string, processName: string): boolean {
  const lower = (appName + ' ' + processName).toLowerCase()
  return [...KNOWN_GAMES].some((game) => lower.includes(game.toLowerCase()))
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

      if (shareAppActivity && isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const info = await invoke<{ title: string; process_name: string } | null>(
            'get_active_window_info',
          )
          if (info && info.title) {
            const type: UserActivityType = isGameApp(info.title, info.process_name)
              ? 'game'
              : 'app'
            const activity: UserActivity = {
              type,
              name: info.title,
              details: info.process_name || undefined,
            }
            addRecentAppActivity(info.title)
            bestActivity = activity
          }
        } catch (err) {
          console.warn('useActivityDetector: get_active_window_info failed', err)
        }
      }

      if (!bestActivity && shareMediaActivity) {
        if ('mediaSession' in navigator) {
          const metadata = navigator.mediaSession.metadata
          const activity = detectMediaActivity(metadata)
          if (activity) {
            addRecentMediaActivity(activity.name)
            bestActivity = activity
          }
        }
      }

      emitActivity(bestActivity)
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
