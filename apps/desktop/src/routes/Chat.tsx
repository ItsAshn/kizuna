import { useEffect, useState, useCallback, useRef } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSocket } from '../hooks/useSocket'
import { useVoice } from '../hooks/useVoice'
import { useScreenshare } from '../hooks/useScreenshare'
import { fetchChannels, fetchMembers, fetchDMChannels } from '@kizuna/shared'
import ServerPanel from '../components/ServerPanel'
import Sidebar from '../components/Sidebar'
import ChatArea from '../components/ChatArea'
import MemberList from '../components/MemberList'
import ScreenShareOverlay from '../components/ScreenShareOverlay'
import { useNavigate } from 'react-router-dom'
import '../styles/chat.css'

export default function Chat() {
  const navigate = useNavigate()
  const session = useServerStore((s) => s.activeSession)
  const servers = useServerStore((s) => s.servers)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const { setChannels, setMembers, setDMChannels, activeChannelId, activeDMChannelId, setActiveChannel, setActiveDMChannel } = useChatStore()
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
  const [showMembers, setShowMembers] = useState(false)
  const [chatClosing, setChatClosing] = useState(false)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
        const [channels, members, dms] = await Promise.all([
          fetchChannels(session!.url, session!.token),
          fetchMembers(session!.url, session!.token),
          fetchDMChannels(session!.url, session!.token),
        ])
        setChannels(channels)
        setMembers(members)
        setDMChannels(dms)
      } catch {
        setActiveSession(null)
        navigate('/')
      }
    }
    load()
  }, [session?.serverId])

  if (!session) return null

  const shouldShowChat = chatOpen || chatClosing

  return (
    <div className="chat-layout">
      {servers.length > 0 && <ServerPanel />}
      <Sidebar
        joinVoice={joinVoice}
        leaveVoice={leaveVoice}
        toggleMute={toggleMute}
        setAudioBitrate={setAudioBitrate}
        socketRef={socketRef}
        startScreenshare={startScreenshare}
        stopScreenshare={stopScreenshare}
      />
      <div className="chat-main">
        {!chatOpen && !chatClosing && (
          <div className="chat-area__empty">
            <div className="chat-area__empty-content">
              <p className="chat-area__empty-title">Welcome to Kizuna</p>
              <p className="chat-area__empty-subtitle">Select a channel to start chatting</p>
            </div>
          </div>
        )}
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
  )
}
