import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useCallStore } from '../store/callStore'
import { useVoiceStore } from '../store/voiceStore'
import { useSettingsStore } from '../store/settingsStore'
import { useSocket } from '../hooks/useSocket'
import { useVoice } from '../hooks/useVoice'
import { useActivityDetector } from '../hooks/useActivityDetector'
import { useScreenshare } from '../hooks/useScreenshare'
import { useCamera } from '../hooks/useCamera'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { useMobile, useTablet } from '../hooks/useMobile'
import { fetchChannels, fetchMembers, fetchDMChannels, fetchGroupDMChannels, fetchServerInfo, fetchChannelMutes, fetchCategories } from '@kizuna/shared'
import { restoreFromSession } from '../store/keyStore'
import { Loader2 } from 'lucide-react'
import ServerPanel from '../components/ServerPanel'
import UpdateBanner from '../components/UpdateBanner'
import Sidebar from '../components/Sidebar'
import ChatArea from '../components/ChatArea'
import MemberList from '../components/MemberList'
import VoiceOverlay from '../components/VoiceOverlay'
import ScreenShareOverlay from '../components/ScreenShareOverlay'
import CameraPreviewOverlay from '../components/CameraPreviewOverlay'
import ServerMenuModal from '../components/ServerMenuModal'
import SetupWizard from '../components/SetupWizard'
import LoginDialog from '../components/LoginDialog'
import NotificationContainer from '../components/NotificationContainer'
import QuickSwitcher from '../components/QuickSwitcher'
import IncomingCallModal from '../components/IncomingCallModal'
import ExportModal from '../components/ExportModal'
import ConnectDialog from '../components/ConnectDialog'
import ThreadPanel from '../components/ThreadPanel'
import BottomTabBar from '../components/BottomTabBar'
import { useNavigate } from 'react-router-dom'
import { Settings, Plus } from 'lucide-react'
import './Chat.css'

export default function Chat({ onOpenSettings }: { onOpenSettings: () => void }) {
  const navigate = useNavigate()
  const isMobile = useMobile()
  const isTablet = useTablet()
  const session = useServerStore((s) => s.activeSession)
  const refreshSessionUser = useServerStore((s) => s.refreshSessionUser)
  const servers = useServerStore((s) => s.servers)
  const sessions = useServerStore((s) => s.sessions)
  const setActiveServer = useServerStore((s) => s.setActiveServer)
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId)
  const setChannels = useChatStore((s) => s.setChannels)
  const setCategories = useChatStore((s) => s.setCategories)
  const setMembers = useChatStore((s) => s.setMembers)
  const setDMChannels = useChatStore((s) => s.setDMChannels)
  const setGroupDMChannels = useChatStore((s) => s.setGroupDMChannels)
  const setChannelMutes = useChatStore((s) => s.setChannelMutes)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId)
  const activeGroupDMChannelId = useChatStore((s) => s.activeGroupDMChannelId)
  const setActiveChannel = useChatStore((s) => s.setActiveChannel)
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel)
  const setActiveGroupDMChannel = useChatStore((s) => s.setActiveGroupDMChannel)
  const members = useChatStore((s) => s.members)
  const channels = useChatStore((s) => s.channels)
  const dmChannels = useChatStore((s) => s.dmChannels)
  const groupDMChannels = useChatStore((s) => s.groupDMChannels)
  const unreadCounts = useChatStore((s) => s.unreadCounts)
  const serverMentionCounts = useChatStore((s) => s.serverMentionCounts)
  const serverBackgroundEnabled = useSettingsStore((s) => s.serverBackgroundEnabled)
  const customCssEnabled = useSettingsStore((s) => s.customCssEnabled)
  const socketConnected = useSettingsStore((s) => s.socketConnected)
  const socketReconnecting = useSettingsStore((s) => s.socketReconnecting)
  const socketReconnectAttempts = useSettingsStore((s) => s.socketReconnectAttempts)
  const socketRef = useSocket()
  const {
    joinVoice,
    leaveVoice,
    toggleMute,
    sendTransportRef,
    videoElRef,
    startDMCall,
    acceptDMCall,
    rejectDMCall,
    endDMCall,
    connectDMCall,
  } = useVoice(socketRef)
  useActivityDetector(socketRef)
  const { startScreenshare, stopScreenshare } = useScreenshare(socketRef, sendTransportRef)
  const { toggleCamera, cameraStreamRef } = useCamera(socketRef, sendTransportRef)
  const isCameraOn = useCallStore((s) => s.isCameraOn)
  const dmCallStatus = useCallStore((s) => s.dmCallStatus)
  const dmCallChannelId = useCallStore((s) => s.dmCallChannelId)
  const dmCallOtherUsername = useCallStore((s) => s.dmCallOtherUsername)
  const incomingCall = useCallStore((s) => s.incomingCall)
  const dmCallShouldCleanup = useCallStore((s) => s.dmCallShouldCleanup)
  const setDMCallShouldCleanup = useCallStore((s) => s.setDMCallShouldCleanup)
  const clearDMCall = useCallStore((s) => s.clearDMCall)
  const dmCallConnectedRef = useRef(false)
  // Member list is inline only on full desktop; on tablet/phone it opens as an overlay drawer.
  const [showMembers, setShowMembers] = useState(!isMobile && !isTablet)
  const [showMenu, setShowMenu] = useState(false)
  const [showEnvWizard, setShowEnvWizard] = useState(false)
  const [loginForServerId, setLoginForServerId] = useState<string | null>(null)
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [bgInfo, setBgInfo] = useState<{ hasBackground: boolean; backgroundBlur: number; customCss: string | null } | null>(null)
  const [, setInitialLoading] = useState(true)

  type NavEntry =
    | { type: 'server'; serverId: string }
    | { type: 'channel'; channelId: string }
    | { type: 'dm'; dmChannelId: string }
    | { type: 'group-dm'; groupDmId: string }

  const [activeTab, setActiveTab] = useState(0)
  const [navStack, setNavStack] = useState<NavEntry[]>([])
  const [isPushAnim, setIsPushAnim] = useState(false)

  function pushView(entry: NavEntry) {
    setIsPushAnim(true)
    if (entry.type === 'server') setActiveServer(entry.serverId)
    else if (entry.type === 'channel') setActiveChannel(entry.channelId)
    else if (entry.type === 'dm') setActiveDMChannel(entry.dmChannelId)
    else if (entry.type === 'group-dm') setActiveGroupDMChannel(entry.groupDmId)
    setNavStack(prev => [...prev, entry])
    setTimeout(() => setIsPushAnim(false), 300)
  }

  function popView() {
    if (navStack.length === 0) return
    const newStack = navStack.slice(0, -1)
    const newTop = newStack[newStack.length - 1]
    if (!newTop || newTop.type === 'server') {
      setActiveChannel(null)
      setActiveDMChannel(null)
      setActiveGroupDMChannel(null)
    }
    setNavStack(newStack)
  }

  function switchTab(tab: number) {
    // Tapping the already-active tab pops its drill-down back to the tab root.
    if (tab === activeTab && navStack.length > 0) {
      setNavStack([])
    } else {
      setActiveTab(tab)
      setNavStack([])
    }
    useChatStore.getState().setThreadPanelVisible(false)
    setShowMembers(false)
    setActiveChannel(null)
    setActiveDMChannel(null)
    setActiveGroupDMChannel(null)
  }

  // Unified back action: peel off transient overlays (thread, member list)
  // before popping the navigation stack, so the hardware/gesture back button
  // behaves consistently across every surface.
  function goBack() {
    if (useChatStore.getState().threadPanelVisible) {
      useChatStore.getState().setThreadPanelVisible(false)
      return
    }
    if (showMembers) {
      setShowMembers(false)
      return
    }
    popView()
  }

  const navStackRef = useRef(navStack)
  navStackRef.current = navStack
  const showMembersRef = useRef(showMembers)
  showMembersRef.current = showMembers
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack

  useEffect(() => {
    if (!isMobile) return

    function handleBack(e: PopStateEvent) {
      e.preventDefault()
      const canGoBack =
        showMembersRef.current ||
        useChatStore.getState().threadPanelVisible ||
        navStackRef.current.length > 0
      if (canGoBack) {
        goBackRef.current()
        window.history.pushState(null, '', window.location.href)
      }
    }

    window.history.pushState(null, '', window.location.href)
    window.addEventListener('popstate', handleBack)
    return () => window.removeEventListener('popstate', handleBack)
  }, [isMobile])

  const topEntry = navStack[navStack.length - 1]
  const viewKey = topEntry
    ? `${topEntry.type}-${'serverId' in topEntry ? topEntry.serverId : 'channelId' in topEntry ? topEntry.channelId : 'groupDmId' in topEntry ? topEntry.groupDmId : topEntry.dmChannelId}`
    : `tab-${activeTab}`

  const dmUnreadTotal = useMemo(() => {
    let total = 0
    for (const ch of dmChannels) {
      total += unreadCounts[ch.id] ?? 0
    }
    return total
  }, [dmChannels, unreadCounts])

  const serverMentionTotal = useMemo(() => {
    let total = 0
    for (const serverId in serverMentionCounts) {
      total += serverMentionCounts[serverId] ?? 0
    }
    return total
  }, [serverMentionCounts])

  const chatOpen = !!(activeChannelId || activeDMChannelId || activeGroupDMChannelId)

  const channelNavList = useMemo(() => {
    const list: { id: string; type: 'channel' | 'dm' | 'group-dm' }[] = [
      ...channels.filter(c => c.type === 'text').map(c => ({ id: c.id, type: 'channel' as const })),
      ...dmChannels.map(d => ({ id: d.id, type: 'dm' as const })),
      ...groupDMChannels.map(g => ({ id: g.id, type: 'group-dm' as const })),
    ]
    return list
  }, [channels, dmChannels, groupDMChannels])

  useKeyboardShortcuts(useMemo(() => [
    {
      key: 'k',
      ctrl: true,
      handler: () => setShowQuickSwitcher(true),
    },
    {
      key: 'e',
      ctrl: true,
      handler: () => setShowMembers(v => !v),
    },
    {
      key: 'Escape',
      handler: () => {},
      allowInInput: true,
    },
    {
      key: 'ArrowUp',
      alt: true,
      handler: () => {
        if (!channelNavList.length) return
        const currentId = activeChannelId || activeDMChannelId || activeGroupDMChannelId
        const idx = channelNavList.findIndex(c => c.id === currentId)
        const prev = idx <= 0 ? channelNavList[channelNavList.length - 1] : channelNavList[idx - 1]
        if (prev.type === 'channel') setActiveChannel(prev.id)
        else if (prev.type === 'group-dm') setActiveGroupDMChannel(prev.id)
        else setActiveDMChannel(prev.id)
      },
    },
    {
      key: 'ArrowDown',
      alt: true,
      handler: () => {
        if (!channelNavList.length) return
        const currentId = activeChannelId || activeDMChannelId || activeGroupDMChannelId
        const idx = channelNavList.findIndex(c => c.id === currentId)
        const next = idx < 0 || idx >= channelNavList.length - 1 ? channelNavList[0] : channelNavList[idx + 1]
        if (next.type === 'channel') setActiveChannel(next.id)
        else if (next.type === 'group-dm') setActiveGroupDMChannel(next.id)
        else setActiveDMChannel(next.id)
      },
    },
  ], [channelNavList, activeChannelId, activeDMChannelId, setActiveChannel, setActiveDMChannel, setShowMembers]))

  useEffect(() => {
    if (!session) {
      navigate('/')
      return
    }

    restoreFromSession(session.url)
    useChatStore.getState().clearServerData()

    async function load() {
      try {
        await refreshSessionUser()

        const results = await Promise.allSettled([
          fetchChannels(session!.url),
          fetchMembers(session!.url),
          fetchDMChannels(session!.url),
          fetchServerInfo(session!.url),
          fetchChannelMutes(session!.url),
          fetchCategories(session!.url),
          fetchGroupDMChannels(session!.url),
        ])

        const [channelsResult, membersResult, dmsResult, infoResult, mutesResult, categoriesResult, groupDMsResult] = results

        if (channelsResult.status === 'fulfilled') {
          setChannels(channelsResult.value)
        } else {
          console.error('[Chat] Failed to fetch channels:', channelsResult.reason)
          setChannels([])
        }

        if (membersResult.status === 'fulfilled') {
          setMembers(membersResult.value)
        } else {
          console.error('[Chat] Failed to fetch members:', membersResult.reason)
          setMembers([])
        }

        if (dmsResult.status === 'fulfilled') {
          setDMChannels(dmsResult.value)
        } else {
          console.error('[Chat] Failed to fetch DMs:', dmsResult.reason)
          setDMChannels([])
        }

        if (groupDMsResult.status === 'fulfilled') {
          setGroupDMChannels(groupDMsResult.value)
        } else {
          console.error('[Chat] Failed to fetch group DMs:', groupDMsResult.reason)
          setGroupDMChannels([])
        }

        if (infoResult.status === 'fulfilled') {
          setBgInfo({ hasBackground: infoResult.value.hasBackground, backgroundBlur: infoResult.value.backgroundBlur, customCss: infoResult.value.customCss })
        } else {
          console.error('[Chat] Failed to fetch server info:', infoResult.reason)
        }

        if (mutesResult.status === 'fulfilled') {
          const mutesMap: Record<string, number | null> = {}
          for (const m of mutesResult.value) {
            mutesMap[m.channel_id] = m.muted_until
          }
          setChannelMutes(mutesMap)
        } else {
          console.error('[Chat] Failed to fetch channel mutes:', mutesResult.reason)
        }

        if (categoriesResult.status === 'fulfilled') {
          setCategories(categoriesResult.value)
        } else {
          console.error('[Chat] Failed to fetch categories:', categoriesResult.reason)
        }

        setInitialLoading(false)
      } catch (err) {
        console.error('[Chat] Failed to load server data:', err)
        setChannels([])
        setCategories([])
        setMembers([])
        setDMChannels([])
        setInitialLoading(false)
      }
    }
    load()
  }, [session?.serverId])

  useEffect(() => {
    const el = document.getElementById('kizuna-custom-css') as HTMLStyleElement | null
    if (customCssEnabled && bgInfo?.customCss) {
      if (el) {
        el.textContent = bgInfo.customCss
      } else {
        const style = document.createElement('style')
        style.id = 'kizuna-custom-css'
        style.textContent = bgInfo.customCss
        document.head.appendChild(style)
      }
    } else if (el) {
      el.remove()
    }
    return () => {
      const style = document.getElementById('kizuna-custom-css')
      if (style) style.remove()
    }
  }, [session?.serverId, customCssEnabled, bgInfo?.customCss])

  useEffect(() => {
    if (dmCallStatus === 'active' && dmCallChannelId && !dmCallConnectedRef.current) {
      dmCallConnectedRef.current = true
      connectDMCall(dmCallChannelId)
    }
    if (dmCallStatus === 'idle') {
      dmCallConnectedRef.current = false
    }
  }, [dmCallStatus, dmCallChannelId, connectDMCall])

  useEffect(() => {
    if (dmCallShouldCleanup) {
      leaveVoice()
      setDMCallShouldCleanup(false)
      clearDMCall()
    }
  }, [dmCallShouldCleanup, leaveVoice, setDMCallShouldCleanup, clearDMCall])

  const handleBackgroundChanged = useCallback(async () => {
    if (!session) return
    try {
      const info = await fetchServerInfo(session.url)
      setBgInfo({ hasBackground: info.hasBackground, backgroundBlur: info.backgroundBlur, customCss: info.customCss })
    } catch (err) {
      console.error('[Chat] Failed to refresh server info:', err)
    }
  }, [session?.url])

  if (!session) return null

  const showBg = bgInfo?.hasBackground && serverBackgroundEnabled
  const serverName = servers.find(s => s.id === session.serverId)?.name || 'Kizuna'

  function renderServersTab() {
    return (
      <div className="mobile-tab">
        <div className="mobile-tab__header">
          <h1 className="mobile-tab__title">Servers</h1>
          <button
            className="mobile-tab__header-btn"
            onClick={onOpenSettings}
            aria-label="Settings"
          >
            <Settings size={20} />
          </button>
        </div>
        <div className="mobile-tab__body">
          {servers.length === 0 ? (
            <div className="mobile-tab__empty">
              <p className="mobile-tab__empty-text">No servers yet</p>
              <p className="mobile-tab__empty-sub">Connect to a self-hosted server to get started</p>
            </div>
          ) : (
            <div className="mobile-server-grid">
              {servers.map((server) => {
                const isConnected = !!sessions[server.id]
                const mentions = serverMentionCounts[server.id] ?? 0
                return (
                  <button
                    key={server.id}
                    className="mobile-server-card"
                    onClick={() => {
                      if (isConnected) {
                        pushView({ type: 'server', serverId: server.id })
                      } else {
                        setLoginForServerId(server.id)
                      }
                    }}
                  >
                    <div className="mobile-server-card__icon">
                      {server.icon ? (
                        <img
                          src={server.icon}
                          alt=""
                          className="mobile-server-card__icon-img"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        server.name.slice(0, 2).toUpperCase()
                      )}
                      {isConnected && <span className="mobile-server-card__dot" />}
                    </div>
                    <div className="mobile-server-card__info">
                      <p className="mobile-server-card__name">{server.name}</p>
                      <p className="mobile-server-card__url">{server.url}</p>
                    </div>
                    {mentions > 0 && (
                      <span className="mobile-server-card__badge">
                        {mentions > 99 ? '99+' : mentions}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="mobile-tab__footer">
          <button
            className="mobile-tab__cta"
            onClick={() => setShowConnect(true)}
          >
            <Plus size={18} />
            Connect to Server
          </button>
        </div>
      </div>
    )
  }

  function renderDMsTab() {
    return (
      <div className="mobile-tab">
        <div className="mobile-tab__header">
          <h1 className="mobile-tab__title">Messages</h1>
        </div>
        <div className="mobile-tab__body">
          {dmChannels.length === 0 ? (
            <div className="mobile-tab__empty">
              <p className="mobile-tab__empty-text">No messages yet</p>
              <p className="mobile-tab__empty-sub">Join a server and start a conversation</p>
            </div>
          ) : (
            dmChannels.map((dm) => {
              const unread = unreadCounts[dm.id] ?? 0
              return (
                <button
                  key={dm.id}
                  className="mobile-dm-item"
                  onClick={() => pushView({ type: 'dm', dmChannelId: dm.id })}
                >
                  <div className="mobile-dm-item__avatar">
                    {dm.other_display_name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="mobile-dm-item__info">
                    <p className="mobile-dm-item__name">{dm.other_display_name || dm.other_username}</p>
                    <p className="mobile-dm-item__username">@{dm.other_username}</p>
                  </div>
                  {unread > 0 && (
                    <span className="mobile-dm-item__badge">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    )
  }

  function renderYouTab() {
    return (
      <div className="mobile-tab">
        <div className="mobile-tab__header">
          <h1 className="mobile-tab__title">You</h1>
        </div>
        <div className="mobile-tab__body">
          <div className="mobile-you-profile">
            <div className="mobile-you-profile__avatar">
              {session!.user.avatar ? (
                <img src={session!.user.avatar} alt="" className="mobile-you-profile__avatar-img" />
              ) : (
                (session!.user.display_name || session!.user.username)?.[0]?.toUpperCase()
              )}
            </div>
            <p className="mobile-you-profile__name">{session!.user.display_name || session!.user.username}</p>
            <p className="mobile-you-profile__username">@{session!.user.username}</p>
          </div>
          <div className="mobile-you-menu">
            <button className="mobile-you-menu__item" onClick={onOpenSettings}>
              <Settings size={18} />
              <span>Settings</span>
            </button>
            <button className="mobile-you-menu__item" onClick={() => setShowExport(true)}>
              <span>Export / Import</span>
            </button>
            <button className="mobile-you-menu__item" onClick={() => setShowConnect(true)}>
              <Plus size={18} />
              <span>Connect to Server</span>
            </button>
          </div>
          <div className="mobile-you-about">
            <p className="mobile-you-about__name">Kizuna</p>
            <p className="mobile-you-about__desc">Self-hosted voice & chat</p>
          </div>
        </div>
      </div>
    )
  }

  function renderCurrentView() {
    if (!topEntry) {
      switch (activeTab) {
        case 0: return renderServersTab()
        case 1: return renderDMsTab()
        case 2: return renderYouTab()
      }
    }

    if (topEntry.type === 'server') {
      return (
        <Sidebar
          joinVoice={joinVoice}
          leaveVoice={leaveVoice}
          socketRef={socketRef}
          onOpenMenu={() => setShowMenu(true)}
          onBackToServers={popView}
          onOpenChat={() => {
            const state = useChatStore.getState()
            if (state.activeChannelId) {
              pushView({ type: 'channel', channelId: state.activeChannelId })
            } else if (state.activeDMChannelId) {
              pushView({ type: 'dm', dmChannelId: state.activeDMChannelId })
            } else if (state.activeGroupDMChannelId) {
              pushView({ type: 'group-dm', groupDmId: state.activeGroupDMChannelId })
            }
          }}
        />
      )
    }

    if (topEntry.type === 'channel' || topEntry.type === 'dm' || topEntry.type === 'group-dm') {
      return (
        <ChatArea
          socketRef={socketRef}
          onStartDMCall={startDMCall}
          onEndDMCall={endDMCall}
          onBackToSidebar={goBack}
          onToggleMembers={() => setShowMembers((v) => !v)}
          membersOpen={showMembers}
          onOpenEnvWizard={() => setShowEnvWizard(true)}
        />
      )
    }

    return null
  }

  if (isMobile) {
    const hasBg = showBg && navStack.length > 0

    return (
      <>
        <div
          className={`chat-layout chat-layout--mobile${hasBg ? ' chat-layout--mobile--has-bg' : ''}`}
          style={hasBg && session ? {
            '--bg-image': `url(${session.url}/api/server/background)`,
            '--bg-blur': `${bgInfo?.backgroundBlur ?? 0}px`,
          } as React.CSSProperties : undefined}
          data-voice={activeVoiceChannelId ? 'true' : undefined}
        >
          {!socketConnected && (
            <div className="connection-banner">
              {socketReconnecting ? (
                <>
                  <Loader2 size={14} className="connection-banner__spinner" />
                  Reconnecting{socketReconnectAttempts > 0 ? ` (attempt ${socketReconnectAttempts})` : ''}...
                </>
              ) : (
                <>
                  Disconnected from server
                  <button className="connection-banner__reconnect" onClick={() => socketRef.current?.connect()}>
                    Reconnect
                  </button>
                </>
              )}
            </div>
          )}
          <div className="mobile-content" key={viewKey}>
            <div className={`mobile-content__view${isPushAnim ? ' mobile-content__view--push' : ''}`}>
              {renderCurrentView()}
            </div>
          </div>
          <VoiceOverlay
            leaveVoice={leaveVoice}
            toggleMute={toggleMute}
            socketRef={socketRef}
            startScreenshare={startScreenshare}
            stopScreenshare={stopScreenshare}
            dmCallOtherUsername={dmCallOtherUsername}
            toggleCamera={toggleCamera}
            isCameraOn={isCameraOn}
          />
          <BottomTabBar
            activeTab={activeTab}
            onTabChange={switchTab}
            serverMentionCount={serverMentionTotal}
            dmUnreadCount={dmUnreadTotal}
          />
          <MemberList visible={showMembers} onClose={() => setShowMembers(false)} />
      <ScreenShareOverlay videoElRef={videoElRef} stopScreenshare={stopScreenshare} />
      <CameraPreviewOverlay
        cameraStreamRef={cameraStreamRef}
        isCameraOn={isCameraOn}
        toggleCamera={toggleCamera}
        channelId={activeVoiceChannelId}
      />
          {activeChannelId && <ThreadPanel channelId={activeChannelId} />}
          <NotificationContainer />
        </div>
        <UpdateBanner />
        {showExport && <ExportModal onClose={() => setShowExport(false)} />}
        {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} />}
        {showMenu && <ServerMenuModal onClose={() => setShowMenu(false)} onBackgroundChanged={handleBackgroundChanged} />}
        {showEnvWizard && <SetupWizard onClose={() => setShowEnvWizard(false)} />}
        {loginForServerId && <LoginDialog serverId={loginForServerId} onClose={() => setLoginForServerId(null)} />}
        {showQuickSwitcher && <QuickSwitcher onClose={() => setShowQuickSwitcher(false)} />}
        {incomingCall && (
          <IncomingCallModal
            incomingCall={incomingCall}
            onAccept={() => acceptDMCall(incomingCall.dmChannelId, incomingCall.callerUserId, incomingCall.callerUsername)}
            onReject={() => rejectDMCall(incomingCall.dmChannelId)}
          />
        )}
      </>
    )
  }

  return (
    <>
    <div
      className={`chat-layout${showBg ? ' chat-layout--has-bg' : ''}`}
      style={showBg && session ? {
        '--bg-image': `url(${session.url}/api/server/background)`,
        '--bg-blur': `${bgInfo?.backgroundBlur ?? 0}px`,
      } as React.CSSProperties : undefined}
      data-voice={activeVoiceChannelId ? 'true' : undefined}
    >
      {!socketConnected && (
        <div className="connection-banner">
          {socketReconnecting ? (
            <>
              <Loader2 size={14} className="connection-banner__spinner" />
              Reconnecting{socketReconnectAttempts > 0 ? ` (attempt ${socketReconnectAttempts})` : ''}...
            </>
          ) : (
            <>
              Disconnected from server
              <button className="connection-banner__reconnect" onClick={() => socketRef.current?.connect()}>
                Reconnect
              </button>
            </>
          )}
        </div>
      )}
      <div className="nav-panel">
        {servers.length > 0 && <ServerPanel onLoginRequired={setLoginForServerId} onOpenSettings={onOpenSettings} onOpenExport={() => setShowExport(true)} onAddServer={() => setShowConnect(true)} />}
        <div className="sidebar-shell">
          <Sidebar
            joinVoice={joinVoice}
            leaveVoice={leaveVoice}
            socketRef={socketRef}
            onOpenMenu={() => setShowMenu(true)}
          />
          <VoiceOverlay
            leaveVoice={leaveVoice}
            toggleMute={toggleMute}
            socketRef={socketRef}
            startScreenshare={startScreenshare}
            stopScreenshare={stopScreenshare}
            dmCallOtherUsername={dmCallOtherUsername}
            toggleCamera={toggleCamera}
            isCameraOn={isCameraOn}
          />
        </div>
      </div>
      <div className="chat-main">
        <UpdateBanner />
        <div className="chat-main__content">
          {chatOpen ? (
            <ChatArea
              socketRef={socketRef}
              onStartDMCall={startDMCall}
              onEndDMCall={endDMCall}
              onToggleMembers={() => setShowMembers((v) => !v)}
              membersOpen={showMembers}
              onOpenEnvWizard={() => setShowEnvWizard(true)}
            />
          ) : (
            <div className="chat-placeholder">
              <div className="chat-placeholder__icon">
                {servers.find(s => s.id === session.serverId)?.icon ? (
                  <img src={servers.find(s => s.id === session.serverId)!.icon} alt="" className="chat-placeholder__icon-img" />
                ) : serverName.slice(0, 2).toUpperCase()}
              </div>
              <h1 className="chat-placeholder__title">Welcome to {serverName}</h1>
              <p className="chat-placeholder__subtitle">Select a channel or direct message to start chatting</p>
              <div className="chat-placeholder__stats">
                <div className="chat-placeholder__stat">
                  <span className="chat-placeholder__stat-value">{members.length}</span>
                  <span className="chat-placeholder__stat-label">Members</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <MemberList visible={showMembers} onClose={() => setShowMembers(false)} />
      <ScreenShareOverlay videoElRef={videoElRef} stopScreenshare={stopScreenshare} />
      <ThreadPanel channelId={activeChannelId!} />
      <NotificationContainer />
    </div>
    {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} />}
    {showMenu && <ServerMenuModal onClose={() => setShowMenu(false)} onBackgroundChanged={handleBackgroundChanged} />}
    {showEnvWizard && <SetupWizard onClose={() => setShowEnvWizard(false)} />}
    {loginForServerId && <LoginDialog serverId={loginForServerId} onClose={() => setLoginForServerId(null)} />}
    {showQuickSwitcher && <QuickSwitcher onClose={() => setShowQuickSwitcher(false)} />}
    {incomingCall && (
      <IncomingCallModal
        incomingCall={incomingCall}
        onAccept={() => acceptDMCall(incomingCall.dmChannelId, incomingCall.callerUserId, incomingCall.callerUsername)}
        onReject={() => rejectDMCall(incomingCall.dmChannelId)}
      />
    )}
    </>
  )
}
