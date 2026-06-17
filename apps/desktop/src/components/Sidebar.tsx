import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useMobile } from '../hooks/useMobile'
import { useNavigate } from 'react-router-dom'
import { createChannel, lockChannel, fetchRoles, setChannelMute, deleteChannelMute, deleteChannel, reorderChannels } from '@kizuna/shared'
import type { CustomRole, Channel } from '@kizuna/shared'
import { Lock, Unlock, BellOff, ChevronLeft } from 'lucide-react'
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
  onBackToServers?: () => void
}

export default function Sidebar({ joinVoice, leaveVoice, toggleMute, socketRef, startScreenshare, stopScreenshare, onOpenMenu, onBackToServers }: SidebarProps) {
  const navigate = useNavigate()
  const isMobile = useMobile()
  const session = useServerStore((s) => s.activeSession)
  const servers = useServerStore((s) => s.servers)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const {
    channels,
    dmChannels, activeChannelId, activeDMChannelId,
    unreadCounts, mentionCounts,
    setActiveChannel, setActiveDMChannel, setChannels,
    channelMutes,
    members,
  } = useChatStore()
  const {
    activeVoiceChannelId,
    voiceChannelUsers,
  } = useVoiceStore()
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
  const [drag, setDrag] = useState<{ channelId: string; type: 'text' | 'voice' } | null>(null)
  const [dragOver, setDragOver] = useState<{ channelId: string; position: 'above' | 'below' } | null>(null)

  function handleDragStart(e: React.DragEvent, ch: Channel) {
    if (isMobile) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ch.id)
    setDrag({ channelId: ch.id, type: ch.type })
  }

  function handleDragEnd() {
    setDrag(null)
    setDragOver(null)
  }

  function handleDragOver(e: React.DragEvent, ch: Channel) {
    if (!drag || drag.type !== ch.type || drag.channelId === ch.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDragOver({ channelId: ch.id, position: e.clientY < rect.top + rect.height / 2 ? 'above' : 'below' })
  }

  function handleDragLeave(e: React.DragEvent, ch: Channel) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      setDragOver((prev) => (prev?.channelId === ch.id ? null : prev))
    }
  }

  function handleDrop(e: React.DragEvent, targetCh: Channel) {
    e.preventDefault()
    if (!drag || !dragOver || !session) return
    if (drag.type !== targetCh.type) return

    const sameType = channels.filter((c) => c.type === drag.type)
    const otherType = channels.filter((c) => c.type !== drag.type)
    const fromIdx = sameType.findIndex((c) => c.id === drag.channelId)
    if (fromIdx === -1) return

    const reordered = [...sameType]
    reordered.splice(fromIdx, 1)

    let insertAt = reordered.findIndex((c) => c.id === targetCh.id)
    if (dragOver.position === 'below') insertAt++
    if (insertAt < 0) insertAt = reordered.length
    reordered.splice(insertAt, 0, sameType[fromIdx])

    const basePos = drag.type === 'text' ? 0 : otherType.length
    const order = reordered.map((c, i) => ({ id: c.id, position: basePos + i }))

    const allOrdered = drag.type === 'text'
      ? [...reordered, ...otherType]
      : [...otherType, ...reordered]

    setChannels(allOrdered)
    setDrag(null)
    setDragOver(null)
    reorderChannels(session.url, order).catch((err) => { console.error('Failed to reorder channels:', err) })
  }

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
    } catch (err) {
      console.error('Failed to toggle channel lock:', err)
    }
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
        items: [
          { label: 'Edit Channel', onClick: () => { setContextMenuChannelId(null); setSettingsChannel(ch) } },
          { label: 'Delete Channel', danger: true, onClick: () => {
            if (confirm(`Delete #${ch.name}? This will permanently delete the channel and all its messages.`)) {
              if (session) deleteChannel(session.url, ch.id).catch((err) => { console.error('Failed to delete channel:', err) })
            }
          }},
        ],
      })
    }

    if (isMuted) {
      sections.push({
        items: [{ label: 'Unmute Channel', onClick: () => { if (session) deleteChannelMute(session.url, channelId).catch((err) => { console.error('Failed to unmute channel:', err) }) } }],
      })
    } else {
      const now = Date.now()
      sections.push({
        items: [
          { label: 'Mute for 15 minutes', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 15 * 60 * 1000).catch((err) => { console.error('Failed to mute channel:', err) }) } },
          { label: 'Mute for 1 hour', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 60 * 60 * 1000).catch((err) => { console.error('Failed to mute channel:', err) }) } },
          { label: 'Mute for 3 hours', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 3 * 60 * 60 * 1000).catch((err) => { console.error('Failed to mute channel:', err) }) } },
          { label: 'Mute for 8 hours', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 8 * 60 * 60 * 1000).catch((err) => { console.error('Failed to mute channel:', err) }) } },
          { label: 'Mute for 24 hours', onClick: () => { if (session) setChannelMute(session.url, channelId, now + 24 * 60 * 60 * 1000).catch((err) => { console.error('Failed to mute channel:', err) }) } },
          { label: 'Mute forever', onClick: () => { if (session) setChannelMute(session.url, channelId, null).catch((err) => { console.error('Failed to mute channel:', err) }) } },
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
      } catch (err) {
        console.error('Failed to fetch roles for lock menu:', err)
      }
    }
    setLockMenuChannelId(lockMenuChannelId === channelId ? null : channelId)
  }

  return (
    <div className="sidebar" role="navigation" aria-label="Channels and direct messages">
      {isMobile && onBackToServers && (
        <div className="sidebar__mobile-header">
          <button
            className="sidebar__mobile-back"
            onClick={onBackToServers}
            aria-label="Back to servers"
          >
            <ChevronLeft className="icon-md" />
          </button>
          <span className="sidebar__mobile-server-name">
            {servers.find(s => s.id === session?.serverId)?.name || 'Kizuna'}
          </span>
          <button
            onClick={onOpenMenu}
            className="sidebar__mobile-menu-btn"
            aria-label="Server menu"
          >
            ···
          </button>
        </div>
      )}
      {!isMobile && (
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
      )}

      <div className="sidebar__content">
        {textChannels.length > 0 && (
          <div className="sidebar__section">
            <h3 className="sidebar__section-title">Text Channels</h3>
            {textChannels.map((ch) => {
              const mentionBadge = mentionCounts[ch.id]
              const unreadOnly = !mentionBadge && unreadCounts[ch.id]
              const isDragging = drag?.channelId === ch.id
              const isDropAbove = dragOver?.channelId === ch.id && dragOver.position === 'above'
              const isDropBelow = dragOver?.channelId === ch.id && dragOver.position === 'below'
              let wrapClass = 'sidebar__channel-wrap'
              if (isDragging) wrapClass += ' sidebar__channel-wrap--dragging'
              if (isDropAbove) wrapClass += ' sidebar__channel-wrap--drop-above'
              if (isDropBelow) wrapClass += ' sidebar__channel-wrap--drop-below'
              return (
                <div
                  key={ch.id}
                  className={wrapClass}
                    onDragOver={(e) => { if (isAdmin && !isMobile) handleDragOver(e, ch) }}
                    onDragLeave={(e) => { if (isAdmin && !isMobile) handleDragLeave(e, ch) }}
                    onDrop={(e) => { if (isAdmin && !isMobile) handleDrop(e, ch) }}
                >
                  <button
                    draggable={isAdmin && !isMobile}
                    onDragStart={(e) => { if (isAdmin && !isMobile) handleDragStart(e, ch) }}
                    onDragEnd={handleDragEnd}
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
              const isDragging = drag?.channelId === ch.id
              const isDropAbove = dragOver?.channelId === ch.id && dragOver.position === 'above'
              const isDropBelow = dragOver?.channelId === ch.id && dragOver.position === 'below'
              let wrapClass = 'sidebar__channel-wrap'
              if (isDragging) wrapClass += ' sidebar__channel-wrap--dragging'
              if (isDropAbove) wrapClass += ' sidebar__channel-wrap--drop-above'
              if (isDropBelow) wrapClass += ' sidebar__channel-wrap--drop-below'
              return (
                <div
                  key={ch.id}
                  className={wrapClass}
                    onDragOver={(e) => { if (isAdmin && !isMobile) handleDragOver(e, ch) }}
                    onDragLeave={(e) => { if (isAdmin && !isMobile) handleDragLeave(e, ch) }}
                    onDrop={(e) => { if (isAdmin && !isMobile) handleDrop(e, ch) }}
                >
                  <button
                    draggable={isAdmin && !isMobile}
                    onDragStart={(e) => { if (isAdmin && !isMobile) handleDragStart(e, ch) }}
                    onDragEnd={handleDragEnd}
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

      {settingsChannel && createPortal(
        <ChannelSettingsModal
          channel={settingsChannel}
          onClose={() => setSettingsChannel(null)}
        />,
        document.body,
      )}
    </div>
  )
}
