import { useState, useRef, useCallback } from 'react'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'

export type NavEntry =
  | { type: 'server'; serverId: string }
  | { type: 'channel'; channelId: string }
  | { type: 'dm'; dmChannelId: string }
  | { type: 'group-dm'; groupDmId: string }
  | { type: 'voice'; channelId: string }

export function useMobileNavigation() {
  const [activeTab, setActiveTab] = useState(0)
  const [navStack, setNavStack] = useState<NavEntry[]>([])
  const [navAnim, setNavAnim] = useState<'push' | 'pop' | null>(null)

  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const setActiveChannel = useChatStore((s) => s.setActiveChannel)
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel)
  const setActiveGroupDMChannel = useChatStore((s) => s.setActiveGroupDMChannel)
  const setViewedVoiceChannel = useChatStore((s) => s.setViewedVoiceChannel)

  const pushView = useCallback(
    (entry: NavEntry) => {
      setNavAnim('push')
      if (entry.type === 'server') setActiveServer(entry.serverId)
      else if (entry.type === 'channel') setActiveChannel(entry.channelId)
      else if (entry.type === 'dm') setActiveDMChannel(entry.dmChannelId)
      else if (entry.type === 'group-dm') setActiveGroupDMChannel(entry.groupDmId)
      else if (entry.type === 'voice') setViewedVoiceChannel(entry.channelId)
      setNavStack((prev) => [...prev, entry])
      setTimeout(() => setNavAnim(null), 320)
    },
    [setActiveServer, setActiveChannel, setActiveDMChannel, setActiveGroupDMChannel, setViewedVoiceChannel],
  )

  const popView = useCallback(() => {
    if (navStack.length === 0) return
    const newStack = navStack.slice(0, -1)
    const newTop = newStack[newStack.length - 1]
    if (!newTop || newTop.type === 'server') {
      setActiveChannel(null)
      setActiveDMChannel(null)
      setActiveGroupDMChannel(null)
      setViewedVoiceChannel(null)
    }
    setNavAnim('pop')
    setNavStack(newStack)
    setTimeout(() => setNavAnim(null), 320)
  }, [navStack, setActiveChannel, setActiveDMChannel, setActiveGroupDMChannel, setViewedVoiceChannel])

  const switchTab = useCallback(
    (tab: number) => {
      setNavAnim(null)
      if (tab === activeTab && navStack.length > 0) {
        setNavStack([])
      } else {
        setActiveTab(tab)
        setNavStack([])
      }
      useChatStore.getState().setThreadPanelVisible(false)
      setActiveChannel(null)
      setActiveDMChannel(null)
      setActiveGroupDMChannel(null)
      setViewedVoiceChannel(null)
    },
    [activeTab, navStack.length, setActiveChannel, setActiveDMChannel, setActiveGroupDMChannel, setViewedVoiceChannel],
  )

  const navStackRef = useRef(navStack)
  navStackRef.current = navStack

  const topEntry = navStack[navStack.length - 1]
  const viewKey = topEntry
    ? `${topEntry.type}-${
        'serverId' in topEntry
          ? topEntry.serverId
          : 'channelId' in topEntry
            ? topEntry.channelId
            : 'groupDmId' in topEntry
              ? topEntry.groupDmId
              : topEntry.dmChannelId
      }`
    : `tab-${activeTab}`

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
