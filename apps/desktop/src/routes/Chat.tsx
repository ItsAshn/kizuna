import { useEffect, useState, useCallback, useRef } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSocket } from '../hooks/useSocket'
import { useVoice } from '../hooks/useVoice'
import { useScreenshare } from '../hooks/useScreenshare'
import { fetchChannels, fetchMembers, fetchDMChannels, fetchServerInfo } from '@kizuna/shared'
import ServerPanel from '../components/ServerPanel'
import Sidebar from '../components/Sidebar'
import ChatArea from '../components/ChatArea'
import MemberList from '../components/MemberList'
import ScreenShareOverlay from '../components/ScreenShareOverlay'
import SettingsModal from '../components/SettingsModal'
import ServerMenuModal from '../components/ServerMenuModal'
import { useNavigate } from 'react-router-dom'
import '../styles/chat.css'

export default function Chat() {
  const navigate = useNavigate()
  const session = useServerStore((s) => s.activeSession)
  const servers = useServerStore((s) => s.servers)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const { setChannels, setMembers, setDMChannels, activeChannelId, activeDMChannelId, setActiveChannel, setActiveDMChannel, serverBackgroundEnabled, customCssEnabled } = useChatStore()
  const socketRef = useSocket()
  const {
    joinVoice,
    leaveVoice,
    toggleMute,
    setAudioBitrate,
    sendTransportRef,
    videoElRef,
  } = useVoice(socketRef)
  const { startScreenshare, stopScreenshare } = useScreenshare(socketRef, sendTransportRef)
  const [showMembers, setShowMembers] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [chatClosing, setChatClosing] = useState(false)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [bgInfo, setBgInfo] = useState<{ hasBackground: boolean; backgroundBlur: number; customCss: string | null } | null>(null)

  const closeChat = useCallback(() => {
    setChatClosing(true)
    closeTimeoutRef.current = setTimeout(() => {
      setActiveChannel(null)
      setActiveDMChannel(null)
      setChatClosing(false)
    }, 200)
  }, [setActiveChannel, setActiveDMChannel])

  const chatOpen = !!(activeChannelId || activeDMChannelId)

  useEffect(() => {
    if (chatOpen) {
      setChatClosing(false)
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current)
        closeTimeoutRef.current = null
      }
    }
  }, [activeChannelId, activeDMChannelId])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && chatOpen) closeChat()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [chatOpen, closeChat])

  useEffect(() => {
    if (!session) {
      navigate('/')
      return
    }

    async function load() {
      try {
        const [channels, members, dms, info] = await Promise.all([
          fetchChannels(session!.url, session!.token),
          fetchMembers(session!.url, session!.token),
          fetchDMChannels(session!.url, session!.token),
          fetchServerInfo(session!.url),
        ])
        setChannels(channels)
        setMembers(members)
        setDMChannels(dms)
        setBgInfo({ hasBackground: info.hasBackground, backgroundBlur: info.backgroundBlur, customCss: info.customCss })
      } catch {
        setActiveSession(null)
        navigate('/')
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

  if (!session) return null

  const shouldShowChat = chatOpen || chatClosing

  const showBg = bgInfo?.hasBackground && serverBackgroundEnabled

  return (
    <>
    <div
      className={`chat-layout${showBg ? ' chat-layout--has-bg' : ''}`}
      style={showBg && session ? {
        '--bg-image': `url(${session.url}/api/server/background)`,
        '--bg-blur': `${bgInfo?.backgroundBlur ?? 0}px`,
      } as React.CSSProperties : undefined}
    >
      {servers.length > 0 && <ServerPanel />}
      <Sidebar
        joinVoice={joinVoice}
        leaveVoice={leaveVoice}
        toggleMute={toggleMute}
        setAudioBitrate={setAudioBitrate}
        socketRef={socketRef}
        startScreenshare={startScreenshare}
        stopScreenshare={stopScreenshare}
        onOpenSettings={() => setShowSettings(true)}
        onOpenMenu={() => setShowMenu(true)}
      />
      <div className="chat-main">
        {shouldShowChat && (
          <div className={`chat-modal-overlay${chatClosing ? ' chat-modal-overlay--closing' : ''}`} onClick={closeChat}>
            <div className={`chat-modal${chatClosing ? ' chat-modal--closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <button className="chat-modal__close-btn" onClick={closeChat}>[esc]</button>
              <ChatArea socketRef={socketRef} />
            </div>
          </div>
        )}
      </div>
      <MemberList visible={showMembers} />
      <button
        onClick={() => setShowMembers(!showMembers)}
        className="btn-secondary"
        style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 40, fontSize: '12px', padding: '4px 12px' }}
      >
        {showMembers ? 'Hide Members' : 'Members'}
      </button>
      <ScreenShareOverlay videoElRef={videoElRef} stopScreenshare={stopScreenshare} />
    </div>
    {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    {showMenu && <ServerMenuModal onClose={() => setShowMenu(false)} />}
    </>
  )
}
