import { useEffect, useState, useMemo, useRef } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSocket } from '../hooks/useSocket'
import { useVoice } from '../hooks/useVoice'
import { useScreenshare } from '../hooks/useScreenshare'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { fetchChannels, fetchMembers, fetchDMChannels, fetchServerInfo, fetchChannelMutes } from '@kizuna/shared'
import { restoreFromSession } from '../store/keyStore'
import { Loader2, Users } from 'lucide-react'
import ServerPanel from '../components/ServerPanel'
import UpdateBanner from '../components/UpdateBanner'
import Sidebar from '../components/Sidebar'
import ChatArea from '../components/ChatArea'
import MemberList from '../components/MemberList'
import ScreenShareOverlay from '../components/ScreenShareOverlay'
import ServerMenuModal from '../components/ServerMenuModal'
import EnvStatus from '../components/EnvStatus'
import SetupWizard from '../components/SetupWizard'
import LoginDialog from '../components/LoginDialog'
import NotificationContainer from '../components/NotificationContainer'
import QuickSwitcher from '../components/QuickSwitcher'
import IncomingCallModal from '../components/IncomingCallModal'
import ExportModal from '../components/ExportModal'
import { useNavigate } from 'react-router-dom'
import '../styles/chat.css'

export default function Chat({ onOpenSettings }: { onOpenSettings: () => void }) {
  const navigate = useNavigate()
  const session = useServerStore((s) => s.activeSession)
  const refreshSessionUser = useServerStore((s) => s.refreshSessionUser)
  const servers = useServerStore((s) => s.servers)
  const {
    setChannels, setMembers, setDMChannels,
    activeChannelId, activeDMChannelId,
    setActiveChannel, setActiveDMChannel,
    serverBackgroundEnabled, customCssEnabled,
    setChannelMutes, socketConnected, socketReconnecting, socketReconnectAttempts,
    members, channels, dmChannels,
  } = useChatStore()
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
  const { startScreenshare, stopScreenshare } = useScreenshare(socketRef, sendTransportRef)
  const {
    dmCallStatus, dmCallChannelId, dmCallOtherUserId, dmCallOtherUsername,
    incomingCall, setIncomingCall, dmCallShouldCleanup, setDMCallShouldCleanup,
    clearDMCall,
  } = useChatStore()
  const dmCallConnectedRef = useRef(false)
  const [showMembers, setShowMembers] = useState(true)
  const [showMenu, setShowMenu] = useState(false)
  const [showEnvWizard, setShowEnvWizard] = useState(false)
  const [loginForServerId, setLoginForServerId] = useState<string | null>(null)
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [bgInfo, setBgInfo] = useState<{ hasBackground: boolean; backgroundBlur: number; customCss: string | null } | null>(null)
  const [initialLoading, setInitialLoading] = useState(true)

  const chatOpen = !!(activeChannelId || activeDMChannelId)

  const channelNavList = useMemo(() => {
    const list: { id: string; type: 'channel' | 'dm' }[] = [
      ...channels.filter(c => c.type === 'text').map(c => ({ id: c.id, type: 'channel' as const })),
      ...dmChannels.map(d => ({ id: d.id, type: 'dm' as const })),
    ]
    return list
  }, [channels, dmChannels])

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
        const currentId = activeChannelId || activeDMChannelId
        const idx = channelNavList.findIndex(c => c.id === currentId)
        const prev = idx <= 0 ? channelNavList[channelNavList.length - 1] : channelNavList[idx - 1]
        if (prev.type === 'channel') setActiveChannel(prev.id)
        else setActiveDMChannel(prev.id)
      },
    },
    {
      key: 'ArrowDown',
      alt: true,
      handler: () => {
        if (!channelNavList.length) return
        const currentId = activeChannelId || activeDMChannelId
        const idx = channelNavList.findIndex(c => c.id === currentId)
        const next = idx < 0 || idx >= channelNavList.length - 1 ? channelNavList[0] : channelNavList[idx + 1]
        if (next.type === 'channel') setActiveChannel(next.id)
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

    async function load() {
      try {
        await refreshSessionUser()
        const [channelsList, membersList, dms, info, mutes] = await Promise.all([
          fetchChannels(session!.url),
          fetchMembers(session!.url),
          fetchDMChannels(session!.url),
          fetchServerInfo(session!.url),
          fetchChannelMutes(session!.url),
        ])
        setChannels(channelsList)
        setMembers(membersList)
        setDMChannels(dms)
        setBgInfo({ hasBackground: info.hasBackground, backgroundBlur: info.backgroundBlur, customCss: info.customCss })
        const mutesMap: Record<string, number | null> = {}
        for (const m of mutes) {
          mutesMap[m.channel_id] = m.muted_until
        }
        setChannelMutes(mutesMap)
        setInitialLoading(false)
      } catch {
        setChannels([])
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

  if (!session) return null

  const showBg = bgInfo?.hasBackground && serverBackgroundEnabled
  const serverName = servers.find(s => s.id === session.serverId)?.name || 'Kizuna'

  return (
    <>
    <div
      className={`chat-layout${showBg ? ' chat-layout--has-bg' : ''}`}
      style={showBg && session ? {
        '--bg-image': `url(${session.url}/api/server/background)`,
        '--bg-blur': `${bgInfo?.backgroundBlur ?? 0}px`,
      } as React.CSSProperties : undefined}
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
      {servers.length > 0 && <ServerPanel onLoginRequired={setLoginForServerId} onOpenSettings={onOpenSettings} onOpenExport={() => setShowExport(true)} />}
      <Sidebar
        joinVoice={joinVoice}
        leaveVoice={leaveVoice}
        toggleMute={toggleMute}
        socketRef={socketRef}
        startScreenshare={startScreenshare}
        stopScreenshare={stopScreenshare}
        onOpenMenu={() => setShowMenu(true)}
      />
      <div className="chat-main">
        <UpdateBanner />
        <div className="chat-main__content">
          {chatOpen ? (
            <>
              <div className="chat-toolbar">
                <div className="chat-toolbar__left">
                  <EnvStatus onOpenWizard={() => setShowEnvWizard(true)} />
                </div>
                <button
                  onClick={() => setShowMembers(!showMembers)}
                  className={`chat-toolbar__members-btn${showMembers ? ' chat-toolbar__members-btn--active' : ''}`}
                  title={showMembers ? 'Hide member list' : 'Show member list'}
                  aria-label={showMembers ? 'Hide member list' : 'Show member list'}
                >
                  <Users size={14} />
                  <span>{members.length}</span>
                </button>
              </div>
              <ChatArea
                socketRef={socketRef}
                onStartDMCall={startDMCall}
                onEndDMCall={endDMCall}
              />
            </>
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
      <MemberList visible={showMembers} />
      <ScreenShareOverlay videoElRef={videoElRef} stopScreenshare={stopScreenshare} />
      <NotificationContainer />
    </div>
    {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    {showMenu && <ServerMenuModal onClose={() => setShowMenu(false)} />}
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
