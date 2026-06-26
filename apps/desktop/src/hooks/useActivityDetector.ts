import { useEffect, useRef, useCallback } from 'react'
import type { Socket } from 'socket.io-client'
import { useSettingsStore } from '../store/settingsStore'

import { isTauri } from '../utils/platform'
import type { UserActivity, UserActivityType } from '@kizuna/shared'

const SWITCH_DELAY_MS = 10_000

// Lazily import the Tauri invoke fn once, instead of re-importing on every poll.
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
let invokePromise: Promise<InvokeFn> | null = null
function getInvoke(): Promise<InvokeFn> {
  if (!invokePromise) {
    invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke as InvokeFn)
  }
  return invokePromise
}

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

const SUPPRESSED_APPS = new Set([
  // ── Password managers / auth ─────────────────────────────
  'keepassxc', 'keepass', 'keepass2', 'bitwarden', '1password',
  'lastpass', 'dashlane', 'nordpass', 'authy', 'enpass',
  'keeper', 'secrets', 'gopass',
  'kwallet', 'kwalletmanager', 'kwalletmanager5', 'kwalletd', 'kwalletd5',
  'seahorse', 'gnome-keyring', 'gnome-keyring-daemon', 'gnome-keyring-prompt',
  'gnome-ssh-askpass', 'ksshaskpass',
  'polkit-gnome-authentication-agent-1', 'polkit-kde-authentication-agent-1',
  'lxpolkit', 'lxsession',

  // ── Lock screens & login (system, not user apps) ─────────
  'i3lock', 'swaylock', 'swaylock-effects', 'gtklock', 'hyprlock',
  'kscreenlocker', 'kscreenlocker_greet', 'xscreensaver',
  'gnome-screensaver', 'gnome-screensaver-dialog',
  'lightdm', 'lightdm-gtk-greeter', 'gdm', 'gdm-password', 'gdm-session-worker',
  'sddm', 'sddm-greeter', 'ly', 'greetd', 'loginwindow',
  'lockapp.exe', 'logonui.exe', 'winlogon.exe', 'msgina.dll',
  'screensaverengine',

  // ── Desktop shell internals (not user apps) ──────────────
  'plasmashell', 'kded5', 'gnome-shell',
  'dwm.exe', 'desktop window manager',
  'dock', 'notificationcenter', 'menuextras', 'systemuiserver',
  'windowserver', 'controlcenter',
  'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
  'textinputhost.exe', 'searchhost.exe', 'searchui.exe',

  // ── Finance ──────────────────────────────────────────────
  'gnucash', 'kmymoney', 'skrooge', 'homebank',
  'moneymanagerex', 'quicken', 'quickbooks', 'moneydance', 'ynab',

  // ── This app itself ──────────────────────────────────────
  'kizuna', 'kizuna-desktop', 'com.kizuna.desktop',
])

const APP_DISPLAY_NAMES: Record<string, string> = {
  // Browsers
  'code': 'Visual Studio Code', 'code-oss': 'VS Code - OSS',
  'code.exe': 'Visual Studio Code', 'code-oss.exe': 'VS Code - OSS',
  'codium': 'VSCodium',
  'sublime_text': 'Sublime Text', 'sublime_merge': 'Sublime Merge',
  'atom': 'Atom',
  // JetBrains
  'jetbrains-idea': 'IntelliJ IDEA',
  'idea64.exe': 'IntelliJ IDEA',
  'jetbrains-studio': 'Android Studio',
  'studio64.exe': 'Android Studio',
  'jetbrains-pycharm': 'PyCharm',
  'pycharm64.exe': 'PyCharm',
  'jetbrains-webstorm': 'WebStorm',
  'webstorm64.exe': 'WebStorm',
  'jetbrains-goland': 'GoLand',
  'goland64.exe': 'GoLand',
  'jetbrains-clion': 'CLion',
  'clion64.exe': 'CLion',
  'jetbrains-phpstorm': 'PhpStorm',
  'jetbrains-rider': 'Rider',
  'jetbrains-rubymine': 'RubyMine',
  'jetbrains-datagrip': 'DataGrip',
  'jetbrains-fleet': 'Fleet',
  'notepad++': 'Notepad++', 'notepad++.exe': 'Notepad++',
  // Terminals
  'cmd.exe': 'Command Prompt', 'cmd': 'Command Prompt',
  'powershell.exe': 'PowerShell', 'powershell': 'PowerShell',
  'pwsh.exe': 'PowerShell', 'pwsh': 'PowerShell',
  'windowsterminal': 'Windows Terminal', 'windowsterminal.exe': 'Windows Terminal',
  'wt.exe': 'Windows Terminal',
  'terminal.app': 'Terminal', 'iterm2': 'iTerm2',
  // File managers
  'org.gnome.nautilus': 'Files',
  'org.kde.dolphin': 'Dolphin',
  'explorer.exe': 'File Explorer', 'explorer': 'File Explorer',
  // Office
  'libreoffice': 'LibreOffice',
  'libreoffice-writer': 'LibreOffice Writer',
  'libreoffice-calc': 'LibreOffice Calc',
  'libreoffice-impress': 'LibreOffice Impress',
  'soffice': 'LibreOffice',
  'winword.exe': 'Microsoft Word',
  'excel.exe': 'Microsoft Excel',
  'powerpnt.exe': 'Microsoft PowerPoint',
  'evince': 'Document Viewer',
  // Graphics
  'gimp-2.10': 'GIMP',
  'photoshop.exe': 'Adobe Photoshop',
  'illustrator.exe': 'Adobe Illustrator',
  // Communication
  'teams': 'Microsoft Teams', 'teams.exe': 'Microsoft Teams',
  'skypeforlinux': 'Skype',
  // Game launchers
  'heroic': 'Heroic Games Launcher',
  'epicgameslauncher.exe': 'Epic Games',
  'ubisoftconnect.exe': 'Ubisoft Connect',
  'battle.net': 'Battle.net', 'battle.net.exe': 'Battle.net',
  // Dev tools
  'git-gui': 'Git GUI', 'git-cola': 'Git Cola',
  'mysql-workbench': 'MySQL Workbench',
  'mongodb-compass': 'MongoDB Compass',
  'virt-manager': 'Virtual Machine Manager',
  'gnome-boxes': 'Boxes',
  // Sys tools
  'gnome-control-center': 'Settings',
  'systemmonitor': 'System Monitor',
  'gnome-system-monitor': 'System Monitor',
  'taskmgr.exe': 'Task Manager', 'taskmgr': 'Task Manager',
  'pavucontrol': 'Volume Control', 'pavucontrol-qt': 'Volume Control',
} as const

function isSuppressedApp(processName: string): boolean {
  return SUPPRESSED_APPS.has(processName.toLowerCase())
}

function processDisplayName(processName: string): string {
  const lower = processName.toLowerCase()
  if (APP_DISPLAY_NAMES[lower]) {
    return APP_DISPLAY_NAMES[lower]
  }

  return lower
    .replace(/\.exe$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || lower
}

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

async function fetchAppIcon(processName: string): Promise<string | undefined> {
  try {
    const invoke = await getInvoke()
    const icon = await invoke<{ data: string } | null>('get_app_icon', { processName })
    return icon?.data
  } catch {
    return undefined
  }
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
  const iconCacheRef = useRef<Map<string, string>>(new Map())
  // Last names written to recent-activity history, so we only write on change.
  const lastRecentAppRef = useRef<string | null>(null)
  const lastRecentMediaRef = useRef<string | null>(null)

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
          const info = await invoke<{ title: string; process_name: string } | null>(
            'get_active_window_info',
          )
          if (info && info.title) {
            const isGame = isGameApp(info.title, info.process_name)

            if (isSuppressedApp(info.process_name)) {
              stableWindowKeyRef.current = null
              windowFirstSeenRef.current = 0
            } else {
              const windowKey = info.process_name + '\x00' + info.title

              if (windowKey === stableWindowKeyRef.current) {
                const elapsed = Date.now() - windowFirstSeenRef.current
                if (elapsed >= SWITCH_DELAY_MS) {
                  const type: UserActivityType = isGame ? 'game' : 'app'
                  const name = isGame
                    ? info.title.trim()
                    : processDisplayName(info.process_name)
                  // Cached value may be '' (a cached "no icon" result).
                  const cachedIcon = iconCacheRef.current.get(info.process_name)
                  const icon = isGame ? undefined : cachedIcon || undefined
                  bestActivity = {
                    type,
                    name,
                    details: !isGame ? info.process_name || undefined : undefined,
                    icon,
                  }
                  if (!isGame && name !== lastRecentAppRef.current) {
                    addRecentAppActivity(name)
                    lastRecentAppRef.current = name
                  }

                  // Fetch icon in the background once per process (cache negatives too).
                  if (!isGame && !iconCacheRef.current.has(info.process_name)) {
                    const proc = info.process_name
                    fetchAppIcon(proc).then((iconData) => {
                      iconCacheRef.current.set(proc, iconData || '')
                    })
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
          console.warn('useActivityDetector: get_active_window_info failed', err)
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
