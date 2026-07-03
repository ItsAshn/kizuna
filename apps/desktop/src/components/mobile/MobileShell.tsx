import { useMemo, useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import type { SavedServer, DMChannelData, User } from '@kizuna/shared'
import { Loader2 } from 'lucide-react'
import { useChatStore } from '../../store/chatStore'
import BottomTabBar from '../BottomTabBar'
import Sidebar from '../Sidebar'
import ChatArea from '../ChatArea'
import VoiceOverlay from '../VoiceOverlay'
import VoiceChannelView from '../VoiceChannelView'
import ScreenShareOverlay from '../ScreenShareOverlay'
import CameraPreviewOverlay from '../CameraPreviewOverlay'
import ThreadPanel from '../ThreadPanel'
import MemberList from '../MemberList'
import NotificationContainer from '../NotificationContainer'
import MobileServersTab from './MobileServersTab'
import MobileMessagesTab from './MobileMessagesTab'
import MobileYouTab from './MobileYouTab'
import { useMobileNavigation } from '../../hooks/useMobileNavigation'
import { useMobileNavStore } from '../../store/mobileNavStore'
import { useSwipeBack } from '../../hooks/useSwipeBack'
import { useKeyboard } from '../../hooks/useKeyboard'
import { supportsNavTransitions } from '../../lib/navTransitions'
import './MobileShell.css'

interface MobileShellProps {
  session: { url: string; serverId: string; user: User }
  servers: SavedServer[]
  sessions: Record<string, { serverId: string; url: string; token: string }>
  dmChannels: DMChannelData[]
  unreadCounts: Record<string, number>
  serverMentionCounts: Record<string, number>
  socketRef: MutableRefObject<Socket | null>
  socketConnected: boolean
  socketReconnecting: boolean
  socketReconnectAttempts: number
  activeVoiceChannelId: string | null
  activeChannelId: string | null
  showMembers: boolean
  dmCallOtherUsername: string | null
  bgInfo: { hasBackground: boolean; backgroundBlur: number } | null
  serverBackgroundEnabled: boolean
  joinVoice: (channelId: string) => Promise<string | null>
  leaveVoice: () => Promise<void>
  toggleMute: () => void
  toggleCamera: (channelId: string) => void
  startScreenshare: (channelId: string, monitorIndex: number, fps?: number) => Promise<string | null>
  stopScreenshare: () => void
  isCameraOn: boolean
  cameraStreamRef: MutableRefObject<MediaStream | null>
  videoElRef: MutableRefObject<HTMLVideoElement | null>
  startDMCall: (dmChannelId: string, otherUserId: string, otherUsername: string) => void
  endDMCall: () => void
  onOpenSettings: () => void
  onOpenMenu: () => void
  onOpenExport: () => void
  onOpenConnect: () => void
  onOpenEnvWizard: () => void
  onLoginRequired: (serverId: string) => void
  onToggleMembers: () => void
  onCloseMembers: () => void
}

export default function MobileShell({
  session,
  servers,
  sessions,
  dmChannels,
  unreadCounts,
  serverMentionCounts,
  socketRef,
  socketConnected,
  socketReconnecting,
  socketReconnectAttempts,
  activeVoiceChannelId,
  activeChannelId,
  showMembers,
  dmCallOtherUsername,
  bgInfo,
  serverBackgroundEnabled,
  joinVoice,
  leaveVoice,
  toggleMute,
  toggleCamera,
  startScreenshare,
  stopScreenshare,
  isCameraOn,
  cameraStreamRef,
  videoElRef,
  startDMCall,
  endDMCall,
  onOpenSettings,
  onOpenMenu,
  onOpenExport,
  onOpenConnect,
  onOpenEnvWizard,
  onLoginRequired,
  onToggleMembers,
  onCloseMembers,
}: MobileShellProps) {
  const {
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
  } = useMobileNavigation()

  useKeyboard()

  const contentRef = useRef<HTMLDivElement>(null)
  const canSwipe = useCallback(() => navStackRef.current.length > 0, [navStackRef])
  useSwipeBack({ containerRef: contentRef, canSwipe, onCommit: popView })

  /* Native tab bars treat a re-tap of the active root tab as scroll-to-top;
   * with a stack it pops to the root instead (handled by the store). */
  const handleTabChange = useCallback(
    (tab: number) => {
      const { tab: currentTab, stack } = useMobileNavStore.getState()
      if (tab === currentTab && stack.length === 0) {
        contentRef.current
          ?.querySelector('.mobile-tab__body')
          ?.scrollTo({ top: 0, behavior: 'smooth' })
        return
      }
      switchTab(tab)
    },
    [switchTab],
  )

  const viewedVoiceChannelId = useChatStore((s) => s.viewedVoiceChannelId)
  const stageOwnsScreenshare =
    voiceStageVisible &&
    !!viewedVoiceChannelId &&
    viewedVoiceChannelId === activeVoiceChannelId

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

  const showBg =
    bgInfo?.hasBackground && serverBackgroundEnabled && navStack.length > 0
  const hasBg = showBg

  const goBack = useCallback(() => {
    if (useChatStore.getState().threadPanelVisible) {
      useChatStore.getState().setThreadPanelVisible(false)
      return
    }
    if (showMembers) {
      onCloseMembers()
      return
    }
    popView()
  }, [showMembers, onCloseMembers, popView])

  // Hardware back button
  useEffect(() => {
    const goBackFn = () => {
      const canGoBack =
        useChatStore.getState().threadPanelVisible ||
        showMembers ||
        navStackRef.current.length > 0
      if (canGoBack) {
        goBack()
        window.history.pushState(null, '', window.location.href)
      }
    }
    window.history.pushState(null, '', window.location.href)
    window.addEventListener('popstate', goBackFn)
    return () => window.removeEventListener('popstate', goBackFn)
  }, [goBack, showMembers])

  const pushToChat = () => {
    const state = useChatStore.getState()
    if (state.activeChannelId) {
      pushView({ type: 'channel', channelId: state.activeChannelId })
    } else if (state.activeDMChannelId) {
      pushView({ type: 'dm', dmChannelId: state.activeDMChannelId })
    } else if (state.activeGroupDMChannelId) {
      pushView({ type: 'group-dm', groupDmId: state.activeGroupDMChannelId })
    }
  }

  function renderCurrentView() {
    if (!topEntry) {
      switch (activeTab) {
        case 0:
          return (
            <MobileServersTab
              servers={servers}
              sessions={sessions}
              serverMentionCounts={serverMentionCounts}
              onPushView={pushView}
              onLoginRequired={onLoginRequired}
              onOpenSettings={onOpenSettings}
              onOpenConnect={onOpenConnect}
            />
          )
        case 1:
          return (
            <MobileMessagesTab
              dmChannels={dmChannels}
              unreadCounts={unreadCounts}
              onPushView={pushView}
            />
          )
        case 2:
          return (
            <MobileYouTab
              user={session.user}
              onOpenSettings={onOpenSettings}
              onOpenExport={onOpenExport}
              onOpenConnect={onOpenConnect}
            />
          )
      }
    }

    if (topEntry.type === 'server') {
      return (
        <Sidebar
          joinVoice={joinVoice}
          leaveVoice={leaveVoice}
          socketRef={socketRef}
          onOpenMenu={onOpenMenu}
          onBackToServers={popView}
          onOpenVoiceStage={(channelId) =>
            pushView({ type: 'voice', channelId })
          }
          onOpenChat={pushToChat}
        />
      )
    }

    if (topEntry.type === 'voice') {
      return (
        <VoiceChannelView
          channelId={topEntry.channelId}
          joinVoice={joinVoice}
          leaveVoice={leaveVoice}
          toggleMute={toggleMute}
          toggleCamera={toggleCamera}
          startScreenshare={startScreenshare}
          stopScreenshare={stopScreenshare}
          isCameraOn={isCameraOn}
          cameraStreamRef={cameraStreamRef}
          videoElRef={videoElRef}
        />
      )
    }

    if (
      topEntry.type === 'channel' ||
      topEntry.type === 'dm' ||
      topEntry.type === 'group-dm'
    ) {
      return (
        <ChatArea
          socketRef={socketRef}
          onStartDMCall={startDMCall}
          onEndDMCall={endDMCall}
          onBackToSidebar={goBack}
          onToggleMembers={onToggleMembers}
          membersOpen={showMembers}
          onOpenEnvWizard={onOpenEnvWizard}
        />
      )
    }

    return null
  }

  return (
    <>
      <div
        className={`chat-layout chat-layout--mobile${hasBg ? ' chat-layout--mobile--has-bg' : ''}`}
        style={
          hasBg && session
            ? ({
                '--bg-image': `url(${session.url}/api/server/background)`,
                '--bg-blur': `${bgInfo?.backgroundBlur ?? 0}px`,
              } as React.CSSProperties)
            : undefined
        }
        data-voice={activeVoiceChannelId ? 'true' : undefined}
      >
        {!socketConnected && (
          <div className="connection-banner">
            {socketReconnecting ? (
              <>
                <Loader2
                  size={14}
                  className="connection-banner__spinner"
                />
                Reconnecting
                {socketReconnectAttempts > 0
                  ? ` (attempt ${socketReconnectAttempts})`
                  : ''}
                ...
              </>
            ) : (
              <>
                Disconnected from server
                <button
                  className="connection-banner__reconnect"
                  onClick={() => socketRef.current?.connect()}
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        )}

        <div className="mobile-content" ref={contentRef}>
          {/* Keyed so each navigation mounts a fresh view; when the View
              Transitions API drives the animation the fallback mount class
              must stay off or both would animate at once. */}
          <div
            key={viewKey}
            className={`mobile-content__view${supportsNavTransitions ? '' : ` mobile-content__view--${navAnim}`}`}
          >
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
          onTabChange={handleTabChange}
          serverMentionCount={serverMentionTotal}
          dmUnreadCount={dmUnreadTotal}
        />

        <MemberList visible={showMembers} onClose={onCloseMembers} />
        {!stageOwnsScreenshare && (
          <ScreenShareOverlay
            videoElRef={videoElRef}
            stopScreenshare={stopScreenshare}
          />
        )}
        <CameraPreviewOverlay
          cameraStreamRef={cameraStreamRef}
          isCameraOn={isCameraOn}
          toggleCamera={toggleCamera}
          channelId={activeVoiceChannelId}
        />
        {activeChannelId && <ThreadPanel channelId={activeChannelId} />}
        <NotificationContainer />
      </div>
    </>
  )
}
