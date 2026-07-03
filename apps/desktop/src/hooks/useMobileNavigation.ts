import { useRef } from 'react'
import { useMobileNavStore, entryKey } from '../store/mobileNavStore'
import type { NavEntry } from '../store/mobileNavStore'

/* Thin adapter over store/mobileNavStore — navigation state lives there so
 * it survives shell remounts; this hook only derives the render-facing bits
 * (top entry, remount key) for MobileShell. */

export type { NavEntry }

export function useMobileNavigation() {
  const activeTab = useMobileNavStore((s) => s.tab)
  const navStack = useMobileNavStore((s) => s.stack)
  const navAnim = useMobileNavStore((s) => s.anim)
  const pushView = useMobileNavStore((s) => s.push)
  const popView = useMobileNavStore((s) => s.pop)
  const switchTab = useMobileNavStore((s) => s.switchTab)

  const navStackRef = useRef(navStack)
  navStackRef.current = navStack

  const topEntry = navStack[navStack.length - 1]
  const viewKey = entryKey(topEntry, activeTab)
  const voiceStageVisible = topEntry?.type === 'voice'

  return {
    activeTab,
    navStack,
    navAnim,
    topEntry,
    viewKey,
    voiceStageVisible,
    pushView,
    popView,
    switchTab,
    navStackRef,
  }
}
