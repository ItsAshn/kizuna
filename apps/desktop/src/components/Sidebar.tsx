import { useState } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useNavigate } from 'react-router-dom'
import { createChannel, lockChannel, fetchRoles } from '@kizuna/shared'
import type { CustomRole } from '@kizuna/shared'
import { Lock, Unlock } from 'lucide-react'
import VoiceOverlay from './VoiceOverlay'
import UserStatusPicker from './UserStatusPicker'
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
  const [lockMenuChannelId, setLockMenuChannelId] = useState<string | null>(null)
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [rolesLoaded, setRolesLoaded] = useState(false)

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

  async function handleToggleLock(ch: typeof channels[0], locked: boolean, write_role_id?: string | null) {
    if (!session) return
    try {
      const updated = await lockChannel(session.url, session.token, ch.id, locked, write_role_id ?? null)
      setChannels(channels.map(c => c.id === ch.id ? updated : c))
    } catch {}
    setLockMenuChannelId(null)
  }

  async function openLockMenu(channelId: string) {
    if (!session || !isAdmin) return
    if (!rolesLoaded) {
      try {
        const r = await fetchRoles(session.url, session.token)
        setRoles(r)
        setRolesLoaded(true)
      } catch {}
    }
    setLockMenuChannelId(lockMenuChannelId === channelId ? null : channelId)
  }

  return (
    <div className="sidebar">
      <div className="sidebar__header">
        <div className="sidebar__user-row">
          <UserStatusPicker socketRef={socketRef}>
            <div className="sidebar__user-avatar">
              {session?.user.avatar ? (
                <img src={session.user.avatar} alt="" className="sidebar__user-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
              ) : session?.user.display_name?.[0]?.toUpperCase()}
            </div>
          </UserStatusPicker>
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
                <div key={ch.id} className="sidebar__channel-wrap">
                  <button
                    onClick={() => { setActiveChannel(ch.id); setLockMenuChannelId(null) }}
                    className={`sidebar__channel ${activeChannelId === ch.id ? 'sidebar__channel--active' : ''}`}
                  >
                    <span className="sidebar__channel-icon">#</span>
                    <span className="sidebar__channel-name">{ch.name}</span>
                    {ch.locked && (
                      <span className="sidebar__lock-icon" title={ch.write_role_name ? `Locked to ${ch.write_role_name}` : 'Locked'}>
                        <Lock size={10} />
                      </span>
                    )}
                    {badge ? <span className="sidebar__unread-badge">{mentionCounts[ch.id] || unreadCounts[ch.id]}</span> : null}
                  </button>
                  {isAdmin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); openLockMenu(ch.id) }}
                      className={`sidebar__lock-btn ${ch.locked ? 'sidebar__lock-btn--active' : ''}`}
                      title={ch.locked ? 'Unlock channel' : 'Lock channel'}
                    >
                      {ch.locked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                  )}
                  {lockMenuChannelId === ch.id && (
                    <div className="sidebar__lock-menu">
                      {ch.locked ? (
                        <>
                          <span className="sidebar__lock-menu-label">Locked to: {ch.write_role_name || 'no role'}</span>
                          <button onClick={() => handleToggleLock(ch, false, null)} className="sidebar__lock-menu-btn">Unlock</button>
                          {roles.map(r => (
                            <button
                              key={r.id}
                              onClick={() => handleToggleLock(ch, true, r.id)}
                              className={`sidebar__lock-menu-btn ${ch.write_role_id === r.id ? 'sidebar__lock-menu-btn--active' : ''}`}
                            >
                              Change to {r.name}
                            </button>
                          ))}
                        </>
                      ) : (
                        <>
                          <span className="sidebar__lock-menu-label">Lock to role:</span>
                          {roles.map(r => (
                            <button key={r.id} onClick={() => handleToggleLock(ch, true, r.id)} className="sidebar__lock-menu-btn">
                              {r.name}
                            </button>
                          ))}
                          {roles.length === 0 && <span className="sidebar__lock-menu-label">No roles exist. Create one in server menu.</span>}
                        </>
                      )}
                      <button onClick={() => setLockMenuChannelId(null)} className="sidebar__lock-menu-btn sidebar__lock-menu-btn--cancel">Cancel</button>
                    </div>
                  )}
                </div>
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
