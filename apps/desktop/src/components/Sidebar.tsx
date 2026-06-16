import { useState, useRef, useEffect } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useNavigate } from 'react-router-dom'
import { createChannel, lockChannel, fetchRoles, setChannelMute, deleteChannelMute } from '@kizuna/shared'
import type { CustomRole, Channel } from '@kizuna/shared'
import { Lock, Unlock, BellOff } from 'lucide-react'
import VoiceOverlay from './VoiceOverlay'
import UserStatusPicker from './UserStatusPicker'
import ContextMenu from './ContextMenu'
import ChannelSettingsModal from './ChannelSettingsModal'
import '../styles/sidebar.css'

interface SidebarProps {
  joinVoice: (channelId: string) => Promise<string | null>
  leaveVoice: () => Promise<void>
  toggleMute: () => void
  socketRef: React.MutableRefObject<any>
  startScreenshare: (channelId: string, monitorIndex: number, fps: number) => Promise<string | null>
  stopScreenshare: () => void
  onOpenMenu: () => void
}

export default function Sidebar({ joinVoice, leaveVoice, toggleMute, socketRef, startScreenshare, stopScreenshare, onOpenMenu }: SidebarProps) {
  const navigate = useNavigate()
  const session = useServerStore((s) => s.activeSession)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const {
    channels,
    dmChannels, activeChannelId, activeDMChannelId,
    activeVoiceChannelId, unreadCounts, mentionCounts,
    setActiveChannel, setActiveDMChannel,
    channelMutes,
    voiceChannelUsers, members,
    dmCallOtherUsername,
  } = useChatStore()
  const [newChannelName, setNewChannelName] = useState('')
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text')
  const [creating, setCreating] = useState(false)
  const [lockMenuChannelId, setLockMenuChannelId] = useState<string | null>(null)
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [rolesLoaded, setRolesLoaded] = useState(false)
  const [contextMenuChannelId, setContextMenuChannelId] = useState<string | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const lockMenuRef = useRef<HTMLDivElement | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null)

  useEffect(() => {
    if (!lockMenuChannelId) return
    function handleClickOutside(e: MouseEvent) {
      if (lockMenuRef.current && !lockMenuRef.current.contains(e.target as Node)) {
        setLockMenuChannelId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [lockMenuChannelId])

  useEffect(() => {
    if (!lockMenuChannelId) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLockMenuChannelId(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [lockMenuChannelId])

  function handleLogout() {
    const channelId = activeChannelId || activeDMChannelId
    if (channelId) {
      socketRef.current?.emit('typing:stop', { channelId })
    }
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
      await createChannel(session.url, newChannelName.trim(), newChannelType)
      setNewChannelName('')
    } finally {
      setCreating(false)
    }
  }

  async function handleToggleLock(ch: typeof channels[0], locked: boolean, write_role_id?: string | null) {
    if (!session) return
    try {
      await lockChannel(session.url, ch.id, locked, write_role_id ?? null)
    } catch {}
    setLockMenuChannelId(null)
  }

  function handleChannelContextMenu(e: React.MouseEvent, channelId: string) {
    e.preventDefault()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setContextMenuChannelId(channelId)
  }

  function getMuteMenuItems(channelId: string) {
    const ch = channels.find(c => c.id === channelId)
    const isMuted = channelMutes[channelId] !== undefined
    const sections: { items: { label: string; onClick: () => void; danger?: boolean }[] }[] = []

    if (ch && isAdmin) {
      sections.push({
        items: [{ label: 'Edit Channel', onClick: () => { setContextMenuChannelId(null); setSettingsChannel(ch) } }],
      })
    }

    if (isMuted) {
      sections.push({
        items: [{ label: 'Unmute Channel', onClick: () => { if (session) deleteChannelMute(session.url, channelId).catch(() => {}) } }],
      })
    } else {
      const now = Date.now()
      sections.push({
        items: [
          { label: 'Mute for 15 minutes', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 15 * 60 * 1000).catch(() => {}) } },
          { label: 'Mute for 1 hour', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 60 * 60 * 1000).catch(() => {}) } },
          { label: 'Mute for 3 hours', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 3 * 60 * 60 * 1000).catch(() => {}) } },
          { label: 'Mute for 8 hours', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 8 * 60 * 60 * 1000).catch(() => {}) } },
          { label: 'Mute for 24 hours', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 24 * 60 * 60 * 1000).catch(() => {}) } },
          { label: 'Mute forever', onClick: () => { if (session) setChannelMute(session.url, channelId, null).catch(() => {}) } },
        ],
      })
    }
    return sections
  }

  async function openLockMenu(channelId: string) {
    if (!session || !isAdmin) return
    if (!rolesLoaded) {
      try {
        const r = await fetchRoles(session.url)
        setRoles(r)
        setRolesLoaded(true)
      } catch {}
    }
    setLockMenuChannelId(lockMenuChannelId === channelId ? null : channelId)
  }

  return (
    <div className="sidebar" role="navigation" aria-label="Channels and direct messages">
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
              const mentionBadge = mentionCounts[ch.id]
              const unreadOnly = !mentionBadge && unreadCounts[ch.id]
              return (
                <div key={ch.id} className="sidebar__channel-wrap">
                  <button
                    onClick={() => { setActiveChannel(ch.id); setLockMenuChannelId(null) }}
                    onContextMenu={(e) => handleChannelContextMenu(e, ch.id)}
                    className={`sidebar__channel ${activeChannelId === ch.id ? 'sidebar__channel--active' : ''}${unreadOnly ? ' sidebar__channel--unread' : ''}`}
                    aria-label={(ch.type === 'voice' ? 'Voice' : 'Text') + ' channel ' + ch.name + (mentionBadge ? ' — ' + mentionBadge + ' mentions' : '') + (unreadOnly ? ' — unread' : '')}
                    aria-current={activeChannelId === ch.id ? 'page' : undefined}
                  >
                    <span className="sidebar__channel-icon">#</span>
                    <span className="sidebar__channel-name">{ch.name}</span>
                    {channelMutes[ch.id] !== undefined && <BellOff size={10} className="sidebar__mute-icon" />}
                    {mentionBadge ? <span className="sidebar__unread-badge">{mentionBadge > 99 ? '99+' : mentionBadge}</span> : unreadOnly ? <span className="sidebar__unread-dot" /> : null}
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
                    <div className="sidebar__lock-menu" ref={lockMenuRef}>
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
            {voiceChannels.map((ch) => {
              const voiceUsers = voiceChannelUsers[ch.id] || []
              return (
                <div key={ch.id} className="sidebar__channel-wrap">
                  <button
                    onClick={async () => {
                      if (activeVoiceChannelId === ch.id) { await leaveVoice() }
                      else { if (activeVoiceChannelId) await leaveVoice(); joinVoice(ch.id) }
                    }}
                    onContextMenu={(e) => handleChannelContextMenu(e, ch.id)}
                    className={`sidebar__channel ${activeVoiceChannelId === ch.id ? 'sidebar__channel--voice-active' : ''}`}
                  >
                    <span className="sidebar__channel-icon">~</span>
                    <span className="sidebar__channel-name">{ch.name}</span>
                    {channelMutes[ch.id] !== undefined && <BellOff size={10} className="sidebar__mute-icon" />}
                    {activeVoiceChannelId === ch.id && <span className="sidebar__voice-indicator" />}
                  </button>
                  {voiceUsers.length > 0 && (
                    <div className="sidebar__voice-users">
                      {voiceUsers.slice(0, 5).map((u) => {
                        const member = members.find((m) => m.id === u.userId)
                        return (
                          <div key={u.userId} className="sidebar__voice-user">
                            <div className="sidebar__voice-user-avatar">
                              {member?.avatar ? (
                                <img
                                  src={member.avatar}
                                  alt=""
                                  className="sidebar__voice-user-avatar-img"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                                />
                              ) : (
                                (member?.display_name || u.username)[0]?.toUpperCase()
                              )}
                            </div>
                            <span className="sidebar__voice-user-name">
                              {member?.display_name || u.username}
                            </span>
                          </div>
                        )
                      })}
                      {voiceUsers.length > 5 && (
                        <div className="sidebar__voice-user sidebar__voice-user--more">
                          +{voiceUsers.length - 5} more
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {dmChannels.length > 0 && (
          <div className="sidebar__section">
            <h3 className="sidebar__section-title">Direct Messages</h3>
            {dmChannels.map((dm) => {
              const mentionBadge = mentionCounts[dm.id]
              const unreadOnly = !mentionBadge && unreadCounts[dm.id]
              return (
              <button
                key={dm.id}
                onClick={() => setActiveDMChannel(dm.id)}
                className={`sidebar__channel ${activeDMChannelId === dm.id ? 'sidebar__channel--active' : ''}${unreadOnly ? ' sidebar__channel--unread' : ''}`}
              >
                <div className="sidebar__dm-avatar">
                  {dm.other_avatar ? (
                    <img src={dm.other_avatar} alt="" className="sidebar__dm-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                  ) : dm.other_display_name?.[0]?.toUpperCase() || '?'}
                </div>
                <span className="sidebar__channel-name">{dm.other_display_name}</span>
                {mentionBadge ? <span className="sidebar__unread-badge">{mentionBadge > 99 ? '99+' : mentionBadge}</span> : unreadOnly ? <span className="sidebar__unread-dot" /> : null}
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
              autoFocus
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
        dmCallOtherUsername={dmCallOtherUsername}
      />

      <div className="sidebar__footer">
        {showDisconnectConfirm ? (
          <div className="sidebar__disconnect-confirm">
            <span className="sidebar__disconnect-label">Disconnect?</span>
            <div className="sidebar__disconnect-actions">
              <button onClick={handleLogout} className="sidebar__disconnect-btn sidebar__disconnect-btn--confirm">Yes</button>
              <button onClick={() => setShowDisconnectConfirm(false)} className="sidebar__disconnect-btn">No</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowDisconnectConfirm(true)} className="sidebar__logout">Disconnect</button>
        )}
      </div>

      {contextMenuChannelId && (
        <ContextMenu
          x={contextMenuPos.x}
          y={contextMenuPos.y}
          sections={getMuteMenuItems(contextMenuChannelId)}
          onClose={() => setContextMenuChannelId(null)}
        />
      )}

      {settingsChannel && (
        <ChannelSettingsModal
          channel={settingsChannel}
          onClose={() => setSettingsChannel(null)}
        />
      )}
    </div>
  )
}
