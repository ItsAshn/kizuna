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
import VoiceChannelView from '../components/VoiceChannelView'
import SettingsModal, { type SettingsScope } from '../components/SettingsModal'
import SetupWizard from '../components/SetupWizard'
import LoginDialog from '../components/LoginDialog'
import NotificationContainer from '../components/NotificationContainer'
import QuickSwitcher from '../components/QuickSwitcher'
import IncomingCallModal from '../components/IncomingCallModal'
import ExportModal from '../components/ExportModal'
import ConnectDialog from '../components/ConnectDialog'
import ThreadPanel from '../components/ThreadPanel'
import { MobileShell } from '../components/mobile'
import { useNavigate } from 'react-router-dom'
import './Chat.css'

export default function Chat() {
  const navigate = useNavigate()
  const isMobile = useMobile()
  const isTablet = useTablet()
  const session = useServerStore((s) => s.activeSession)
  const refreshSessionUser = useServerStore((s) => s.refreshSessionUser)
  const servers = useServerStore((s) => s.servers)
  const sessions = useServerStore((s) => s.sessions)
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
  const viewedVoiceChannelId = useChatStore((s) => s.viewedVoiceChannelId)
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
  // Unified settings hub: null = closed, otherwise the scope to open on.
  const [settingsScope, setSettingsScope] = useState<SettingsScope | null>(null)
  const [showEnvWizard, setShowEnvWizard] = useState(false)
  const [loginForServerId, setLoginForServerId] = useState<string | null>(null)
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [bgInfo, setBgInfo] = useState<{ hasBackground: boolean; backgroundBlur: number; customCss: string | null } | null>(null)
  const [, setInitialLoading] = useState(true)

  const chatOpen = !!(activeChannelId || activeDMChannelId || activeGroupDMChannelId)
  const stageOwnsScreenshare = !!viewedVoiceChannelId && viewedVoiceChannelId === activeVoiceChannelId

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

  if (isMobile) {
    return (
      <>
        <MobileShell
          session={session}
          servers={servers}
          sessions={sessions}
          dmChannels={dmChannels}
          unreadCounts={unreadCounts}
          serverMentionCounts={serverMentionCounts}
          socketRef={socketRef}
          socketConnected={socketConnected}
          socketReconnecting={socketReconnecting}
          socketReconnectAttempts={socketReconnectAttempts}
          activeVoiceChannelId={activeVoiceChannelId}
          activeChannelId={activeChannelId}
          showMembers={showMembers}
          dmCallOtherUsername={dmCallOtherUsername}
          bgInfo={bgInfo}
          serverBackgroundEnabled={serverBackgroundEnabled}
          joinVoice={joinVoice}
          leaveVoice={leaveVoice}
          toggleMute={toggleMute}
          toggleCamera={toggleCamera}
          startScreenshare={startScreenshare}
          stopScreenshare={stopScreenshare}
          isCameraOn={isCameraOn}
          cameraStreamRef={cameraStreamRef}
          videoElRef={videoElRef}
          startDMCall={startDMCall}
          endDMCall={endDMCall}
          onOpenSettings={() => setSettingsScope('you')}
          onOpenMenu={() => setSettingsScope('server')}
          onOpenExport={() => setShowExport(true)}
          onOpenConnect={() => setShowConnect(true)}
          onOpenEnvWizard={() => setShowEnvWizard(true)}
          onLoginRequired={setLoginForServerId}
          onToggleMembers={() => setShowMembers((v) => !v)}
          onCloseMembers={() => setShowMembers(false)}
        />
        <UpdateBanner />
        {showExport && <ExportModal onClose={() => setShowExport(false)} />}
        {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} />}
        {settingsScope && <SettingsModal initialScope={settingsScope} onClose={() => setSettingsScope(null)} onBackgroundChanged={handleBackgroundChanged} />}
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
        <div className={`connection-banner${socketReconnecting ? ' connection-banner--reconnecting' : ''}`}>
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
        {servers.length > 0 && <ServerPanel onLoginRequired={setLoginForServerId} onOpenSettings={() => setSettingsScope('you')} onOpenExport={() => setShowExport(true)} onAddServer={() => setShowConnect(true)} />}
        <div className="sidebar-shell">
          <Sidebar
            joinVoice={joinVoice}
            leaveVoice={leaveVoice}
            socketRef={socketRef}
            onOpenMenu={() => setSettingsScope('server')}
            voicePanel={
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
            }
          />
        </div>
      </div>
      <div className="chat-main">
        <UpdateBanner />
        <div className="chat-main__content">
          <div className="chat-main__stage">
            {viewedVoiceChannelId ? (
              <VoiceChannelView
                channelId={viewedVoiceChannelId}
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
            ) : chatOpen ? (
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
                  <button
                    className="chat-placeholder__stat"
                    onClick={() => setShowMembers((v) => !v)}
                    aria-pressed={showMembers}
                    title="Toggle member list"
                  >
                    <span className="chat-placeholder__stat-value">{members.length}</span>
                    <span className="chat-placeholder__stat-label">Members</span>
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* Members live inside the chat panel as a divided column. Its
              visibility is owned solely by showMembers, independent of what the
              stage shows; on tablet the same component becomes an overlay. */}
          <MemberList visible={showMembers} onClose={() => setShowMembers(false)} />
        </div>
      </div>
      {!stageOwnsScreenshare && <ScreenShareOverlay videoElRef={videoElRef} stopScreenshare={stopScreenshare} />}
      <ThreadPanel channelId={activeChannelId!} />
      <NotificationContainer />
    </div>
    {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} />}
    {settingsScope && <SettingsModal initialScope={settingsScope} onClose={() => setSettingsScope(null)} onBackgroundChanged={handleBackgroundChanged} />}
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
