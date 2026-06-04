import { useEffect, useState } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useSocket } from '../hooks/useSocket'
import { useVoice } from '../hooks/useVoice'
import { useScreenshare } from '../hooks/useScreenshare'
import { fetchChannels, fetchMembers, fetchDMChannels } from '@kizuna/shared'
import Sidebar from '../components/Sidebar'
import ChatArea from '../components/ChatArea'
import MemberList from '../components/MemberList'
import VoiceOverlay from '../components/VoiceOverlay'
import ScreenShareOverlay from '../components/ScreenShareOverlay'
import { useNavigate } from 'react-router-dom'
import '../styles/chat.css'

export default function Chat() {
  const navigate = useNavigate()
  const session = useServerStore((s) => s.activeSession)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const { setChannels, setMembers, setDMChannels } = useChatStore()
  const socketRef = useSocket()
  const {
    joinVoice,
    leaveVoice,
    toggleMute,
    setAudioBitrate,
    sendTransportRef,
    recvTransportRef,
    videoElRef,
  } = useVoice(socketRef)
  const { startScreenshare, stopScreenshare } = useScreenshare(socketRef, sendTransportRef)
  const [showMembers, setShowMembers] = useState(false)

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

  return (
    <div className="chat-layout">
      <Sidebar joinVoice={joinVoice} leaveVoice={leaveVoice} />
      <ChatArea socketRef={socketRef} />
      <MemberList visible={showMembers} />
      <button
        onClick={() => setShowMembers(!showMembers)}
        className="btn-secondary"
        style={{ position: 'absolute', top: '12px', right: '12px', zIndex: 40, fontSize: '12px', padding: '4px 12px' }}
      >
        {showMembers ? 'Hide Members' : 'Members'}
      </button>
      <ScreenShareOverlay videoElRef={videoElRef} stopScreenshare={stopScreenshare} />
      <VoiceOverlay
        leaveVoice={leaveVoice}
        toggleMute={toggleMute}
        setAudioBitrate={setAudioBitrate}
        socketRef={socketRef}
        startScreenshare={startScreenshare}
        stopScreenshare={stopScreenshare}
      />
    </div>
  )
}
