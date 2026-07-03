import { create } from 'zustand'
import { useChatStore } from './chatStore'
import { useServerStore } from './serverStore'
import { runNavTransition } from '../lib/navTransitions'

/* Mobile navigation stack.
 *
 * Lives in a store (not component state) so the stack survives the shell
 * unmounting — e.g. rotating/resizing across the desktop breakpoint — and so
 * navigation can be driven from anywhere (notification taps, deep links).
 *
 * The chat/server stores remain the single source of truth for *what* is
 * active; this store owns *where the user is* in the mobile UI. Every stack
 * mutation mirrors its top entry into those stores in the same commit, and
 * every mutation runs inside runNavTransition so the platform can animate
 * outgoing and incoming views together.
 *
 * `anim` is the direction of the most recent navigation. It is never reset
 * on a timer: each navigation remounts the view (keyed on entryKey), so the
 * fallback mount animation plays exactly once per navigation. Clearing it
 * later would swap animation classes on a live element and restart them —
 * the flicker bug this design replaced.
 */

export type NavEntry =
  | { type: 'server'; serverId: string }
  | { type: 'channel'; channelId: string }
  | { type: 'dm'; dmChannelId: string }
  | { type: 'group-dm'; groupDmId: string }
  | { type: 'voice'; channelId: string }

export type NavAnim = 'push' | 'pop' | 'tab'

export function entryKey(entry: NavEntry | undefined, tab: number): string {
  if (!entry) return `tab-${tab}`
  switch (entry.type) {
    case 'server':
      return `server-${entry.serverId}`
    case 'channel':
      return `channel-${entry.channelId}`
    case 'dm':
      return `dm-${entry.dmChannelId}`
    case 'group-dm':
      return `group-dm-${entry.groupDmId}`
    case 'voice':
      return `voice-${entry.channelId}`
  }
}

function applyEntry(entry: NavEntry) {
  const chat = useChatStore.getState()
  if (entry.type === 'server') useServerStore.getState().setActiveServer(entry.serverId)
  else if (entry.type === 'channel') chat.setActiveChannel(entry.channelId)
  else if (entry.type === 'dm') chat.setActiveDMChannel(entry.dmChannelId)
  else if (entry.type === 'group-dm') chat.setActiveGroupDMChannel(entry.groupDmId)
  else if (entry.type === 'voice') chat.setViewedVoiceChannel(entry.channelId)
}

function clearActive() {
  const chat = useChatStore.getState()
  chat.setActiveChannel(null)
  chat.setActiveDMChannel(null)
  chat.setActiveGroupDMChannel(null)
  chat.setViewedVoiceChannel(null)
}

interface MobileNavState {
  tab: number
  stack: NavEntry[]
  anim: NavAnim
  push: (entry: NavEntry) => void
  pop: () => void
  /** Switch tabs; re-selecting the current tab pops its stack to the root.
   *  Re-selecting with an empty stack is a no-op here — the shell turns it
   *  into scroll-to-top, which needs DOM access. */
  switchTab: (tab: number) => void
}

export const useMobileNavStore = create<MobileNavState>((set, get) => ({
  tab: 0,
  stack: [],
  anim: 'tab',

  push: (entry) => {
    runNavTransition('push', () => {
      applyEntry(entry)
      set((s) => ({ stack: [...s.stack, entry], anim: 'push' }))
    })
  },

  pop: () => {
    const { stack } = get()
    if (stack.length === 0) return
    const newStack = stack.slice(0, -1)
    const newTop = newStack[newStack.length - 1]
    runNavTransition('pop', () => {
      if (!newTop || newTop.type === 'server') clearActive()
      else applyEntry(newTop)
      set({ stack: newStack, anim: 'pop' })
    })
  },

  switchTab: (tab) => {
    const current = get()
    const popToRoot = tab === current.tab
    if (popToRoot && current.stack.length === 0) return
    runNavTransition(popToRoot ? 'pop' : 'tab', () => {
      useChatStore.getState().setThreadPanelVisible(false)
      clearActive()
      set({ tab, stack: [], anim: popToRoot ? 'pop' : 'tab' })
    })
  },
}))
