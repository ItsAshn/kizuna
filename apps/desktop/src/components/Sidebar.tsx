import { useState } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useNavigate } from 'react-router-dom'
import { createChannel } from '@kizuna/shared'
import VoiceOverlay from './VoiceOverlay'
import '../styles/sidebar.css'

interface SidebarProps {
  joinVoice: (channelId: string) => Promise<string | null>
  leaveVoice: () => void
  toggleMute: () => void
  socketRef: React.MutableRefObject<any>
  startScreenshare: (channelId: string, monitorIndex: number, fps: number) => Promise<string | null>
  stopScreenshare: () => void
  onOpenSettings: () => void
  onOpenMenu: () => void
}

export default function Sidebar({ joinVoice, leaveVoice, toggleMute, socketRef, startScreenshare, stopScreenshare, onOpenSettings, onOpenMenu }: SidebarProps) {
  const navigate = useNavigate()
  const session = useServerStore((s) => s.activeSession)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const {
    channels, setChannels,
    dmChannels, activeChannelId, activeDMChannelId,
    activeVoiceChannelId, unreadCounts, mentionCounts,
    setActiveChannel, setActiveDMChannel,
  } = useChatStore()
  const [newChannelName, setNewChannelName] = useState('')
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text')
  const [creating, setCreating] = useState(false)

  function handleLogout() {
    setActiveSession(null)
    navigate('/')
  }

  const textChannels = channels.filter((c) => c.type === 'text')
  const voiceChannels = channels.filter((c) => c.type === 'voice')
  const isAdmin = session?.user?.role === 'admin'

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault()
    if (!newChannelName.trim() || !session) return
    setCreating(true)
    try {
      const ch = await createChannel(session.url, session.token, newChannelName.trim(), newChannelType)
      setChannels([...channels, ch])
      setNewChannelName('')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <div className="sidebar__user-row">
          <div className="sidebar__user-avatar">
            {session?.user.avatar ? (
              <img src={session.user.avatar} alt="" className="sidebar__user-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            ) : session?.user.display_name?.[0]?.toUpperCase()}
          </div>
          <div className="sidebar__user-info">
            <p className="sidebar__user-displayname">{session?.user.display_name || session?.user.username}</p>
            <p className="sidebar__user-subtitle">@{session?.user.username}{isAdmin ? ' · admin' : ''}</p>
          </div>
          <button
            onClick={onOpenMenu}
            className="sidebar__channel-icon"
            style={{ marginLeft: 'auto', fontSize: '14px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}
            title="server menu"
          >
            ···
          </button>
        </div>
      </div>

      <div className="sidebar__content">
        {textChannels.length > 0 && (
          <div className="sidebar__section">
            <h3 className="sidebar__section-title">Text Channels</h3>
            {textChannels.map((ch) => {
              const badge = mentionCounts[ch.id] || unreadCounts[ch.id]
              return (
                <button
                  key={ch.id}
                  onClick={() => { setActiveChannel(ch.id) }}
                  className={`sidebar__channel ${activeChannelId === ch.id ? 'sidebar__channel--active' : ''}`}
                >
                  <span className="sidebar__channel-icon">#</span>
                  <span className="sidebar__channel-name">{ch.name}</span>
                  {badge ? <span className="sidebar__unread-badge">{mentionCounts[ch.id] || unreadCounts[ch.id]}</span> : null}
                </button>
              )
            })}
          </div>
        )}

        {voiceChannels.length > 0 && (
          <div className="sidebar__section">
            <h3 className="sidebar__section-title">Voice Channels</h3>
            {voiceChannels.map((ch) => (
              <button
                key={ch.id}
                onClick={() => {
                  if (activeVoiceChannelId === ch.id) { leaveVoice() }
                  else { if (activeVoiceChannelId) leaveVoice(); joinVoice(ch.id) }
                }}
                className={`sidebar__channel ${activeVoiceChannelId === ch.id ? 'sidebar__channel--voice-active' : ''}`}
              >
                <span className="sidebar__channel-icon">~</span>
                <span className="sidebar__channel-name">{ch.name}</span>
                {activeVoiceChannelId === ch.id && <span className="sidebar__voice-indicator" />}
              </button>
            ))}
          </div>
        )}

        {dmChannels.length > 0 && (
          <div className="sidebar__section">
            <h3 className="sidebar__section-title">Direct Messages</h3>
            {dmChannels.map((dm) => {
              const badge = unreadCounts[dm.id]
              return (
              <button
                key={dm.id}
                onClick={() => setActiveDMChannel(dm.id)}
                className={`sidebar__channel ${activeDMChannelId === dm.id ? 'sidebar__channel--active' : ''}`}
              >
                <div className="sidebar__dm-avatar">
                  {dm.other_avatar ? (
                    <img src={dm.other_avatar} alt="" className="sidebar__dm-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  ) : dm.other_display_name?.[0]?.toUpperCase() || '?'}
                </div>
                <span className="sidebar__channel-name">{dm.other_display_name}</span>
                {badge ? <span className="sidebar__unread-badge">{badge}</span> : null}
              </button>
              )
            })}
          </div>
        )}

        {session && isAdmin && (
          <form onSubmit={handleCreateChannel} className="sidebar__create-form">
            <span className="sidebar__create-title">New Channel</span>
            <input
              className="sidebar__create-input"
              placeholder="channel-name"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
            />
            <div className="sidebar__create-type-row">
              <div className="sidebar__create-type-toggle">
                <button
                  type="button"
                  onClick={() => setNewChannelType('text')}
                  className={`sidebar__create-type-btn ${newChannelType === 'text' ? 'sidebar__create-type-btn--active' : ''}`}
                >
                  text
                </button>
                <button
                  type="button"
                  onClick={() => setNewChannelType('voice')}
                  className={`sidebar__create-type-btn ${newChannelType === 'voice' ? 'sidebar__create-type-btn--active' : ''}`}
                >
                  voice
                </button>
              </div>
              <button type="submit" disabled={creating} className="sidebar__create-submit">
                {creating ? '...' : 'create'}
              </button>
            </div>
          </form>
        )}
      </div>

      <VoiceOverlay
        leaveVoice={leaveVoice}
        toggleMute={toggleMute}
        socketRef={socketRef}
        startScreenshare={startScreenshare}
        stopScreenshare={stopScreenshare}
      />

      <div className="sidebar__footer">
        <button onClick={onOpenSettings} className="sidebar__logout">Settings</button>
        <button onClick={handleLogout} className="sidebar__logout">Disconnect</button>
      </div>
    </div>
  )
}
