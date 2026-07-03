import { useState, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { createPortal } from 'react-dom'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { useVoiceStore } from '../store/voiceStore'
import { useSettingsStore } from '../store/settingsStore'
import { useMobile } from '../hooks/useMobile'
import { useHaptics } from '../hooks/useHaptics'
import { useSwipeBack } from '../hooks/useSwipeBack'
import { isTauri } from '../utils/platform'
import { useNavigate } from 'react-router-dom'
import { createChannel, setChannelMute, deleteChannelMute, deleteChannel, reorderChannels } from '@kizuna/shared'
import type { Channel } from '@kizuna/shared'
import { BellOff, ChevronLeft, Ellipsis, Bell, Settings } from 'lucide-react'
import UserStatusPicker from './UserStatusPicker'
import { Avatar } from './ui'
import ContextMenu from './ContextMenu'
import ChannelSettingsModal from './ChannelSettingsModal'
import ChannelAccessModal from './ChannelAccessModal'
import CreateGroupDMModal from './CreateGroupDMModal'
import './Sidebar.css'

interface SidebarProps {
  joinVoice: (channelId: string) => Promise<string | null>
  leaveVoice: () => Promise<void>
  socketRef: React.MutableRefObject<Socket | null>
  onOpenMenu: () => void
  onBackToServers?: () => void
  onOpenChat?: () => void
  onOpenVoiceStage?: (channelId: string) => void
  /** Rendered just above the sidebar footer (the voice-connected panel). */
  voicePanel?: React.ReactNode
}

export default function Sidebar({ joinVoice, leaveVoice, socketRef, onOpenMenu, onBackToServers, onOpenChat, onOpenVoiceStage, voicePanel }: SidebarProps) {
  const navigate = useNavigate()
  const isMobile = useMobile()
  const sidebarRef = useRef<HTMLDivElement>(null)
  useSwipeBack(sidebarRef, onBackToServers || (() => {}), !!isMobile && !!onBackToServers)
  const haptics = useHaptics()
  const session = useServerStore((s) => s.activeSession)
  const servers = useServerStore((s) => s.servers)
  const setActiveSession = useServerStore((s) => s.setActiveSession)
  const channels = useChatStore((s) => s.channels)
  const categories = useChatStore((s) => s.categories)
  const dmChannels = useChatStore((s) => s.dmChannels)
  const groupDMChannels = useChatStore((s) => s.groupDMChannels)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId)
  const activeGroupDMChannelId = useChatStore((s) => s.activeGroupDMChannelId)
  const unreadCounts = useChatStore((s) => s.unreadCounts)
  const mentionCounts = useChatStore((s) => s.mentionCounts)
  const channelMutes = useChatStore((s) => s.channelMutes)
  const members = useChatStore((s) => s.members)
  const setActiveChannel = useChatStore((s) => s.setActiveChannel)
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel)
  const setActiveGroupDMChannel = useChatStore((s) => s.setActiveGroupDMChannel)
  const setViewedVoiceChannel = useChatStore((s) => s.setViewedVoiceChannel)
  const setChannels = useChatStore((s) => s.setChannels)
  const {
    activeVoiceChannelId,
    voiceChannelUsers,
    userActivities,
  } = useVoiceStore()
  const shareMediaActivity = useSettingsStore((s) => s.shareMediaActivity)
  const shareAppActivity = useSettingsStore((s) => s.shareAppActivity)
  const channelNotifLevels = useSettingsStore((s) => s.channelNotificationLevels)
  const setChannelNotifLevel = useSettingsStore((s) => s.setChannelNotificationLevel)
  const [newChannelName, setNewChannelName] = useState('')
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice'>('text')
  const [creating, setCreating] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [showCreateGroupDM, setShowCreateGroupDM] = useState(false)
  const [accessModalChannel, setAccessModalChannel] = useState<Channel | null>(null)
  const [contextMenuChannelId, setContextMenuChannelId] = useState<string | null>(null)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const [settingsChannel, setSettingsChannel] = useState<Channel | null>(null)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
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

  function handleLogout() {
    const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId
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

    const currentOverride = channelNotifLevels[channelId]
    sections.push({
      items: [
        { label: `Notifications: ${currentOverride === 'all' ? '✓ ' : ''}All Messages`, onClick: () => setChannelNotifLevel(channelId, 'all') },
        { label: `Notifications: ${currentOverride === 'mentions' ? '✓ ' : ''}Only @mentions`, onClick: () => setChannelNotifLevel(channelId, 'mentions') },
        { label: `Notifications: ${currentOverride === 'none' ? '✓ ' : ''}Nothing`, onClick: () => setChannelNotifLevel(channelId, 'none') },
        { label: `Notifications: ${!currentOverride ? '✓ ' : ''}Use server default`, onClick: () => setChannelNotifLevel(channelId, null) },
      ],
    })

    return sections
  }

  function renderChannel(ch: Channel) {
    const isText = ch.type === 'text'
    const voiceUsers = isText ? [] : (voiceChannelUsers[ch.id] || [])
    const mentionBadge = mentionCounts[ch.id]
    const unreadOnly = !mentionBadge && unreadCounts[ch.id]
    const isDragging = drag?.channelId === ch.id
    const isDropAbove = dragOver?.channelId === ch.id && dragOver.position === 'above'
    const isDropBelow = dragOver?.channelId === ch.id && dragOver.position === 'below'
    let wrapClass = 'sidebar__channel-wrap'
    if (isDragging) wrapClass += ' sidebar__channel-wrap--dragging'
    if (isDropAbove) wrapClass += ' sidebar__channel-wrap--drop-above'
    if (isDropBelow) wrapClass += ' sidebar__channel-wrap--drop-below'
    const channelActive = isText
      ? activeChannelId === ch.id
      : activeVoiceChannelId === ch.id

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
          onClick={() => {
            haptics.tap()
            if (isText) {
              setActiveChannel(ch.id); onOpenChat?.()
            } else {
              setViewedVoiceChannel(ch.id); onOpenVoiceStage?.(ch.id)
              if (activeVoiceChannelId !== ch.id) {
                (async () => {
                  if (activeVoiceChannelId) await leaveVoice()
                  joinVoice(ch.id); haptics.success()
                })()
              }
            }
          }}
          onContextMenu={(e) => handleChannelContextMenu(e, ch.id)}
          className={`sidebar__channel ${channelActive ? (isText ? 'sidebar__channel--active' : 'sidebar__channel--voice-active') : ''}${unreadOnly ? ' sidebar__channel--unread' : ''}`}
          aria-label={(isText ? 'Text' : 'Voice') + ' channel ' + ch.name + (mentionBadge ? ' — ' + mentionBadge + ' mentions' : '') + (unreadOnly ? ' — unread' : '')}
          aria-current={channelActive ? 'page' : undefined}
        >
          <span className="sidebar__channel-icon">{isText ? '#' : '~'}</span>
          <span className="sidebar__channel-name">{ch.name}</span>
          {channelMutes[ch.id] !== undefined && <BellOff size={10} className="sidebar__mute-icon" />}
          {isText && channelNotifLevels[ch.id] && (
            <span className={`sidebar__notif-icon sidebar__notif-icon--${channelNotifLevels[ch.id]}`} title={`Notifications: ${channelNotifLevels[ch.id]}`}>
              <Bell size={10} />
            </span>
          )}
          {mentionBadge ? <span className="sidebar__unread-badge">{mentionBadge > 99 ? '99+' : mentionBadge}</span> : unreadOnly ? <span className="sidebar__unread-dot" /> : null}
          {!isText && activeVoiceChannelId === ch.id && <span className="sidebar__voice-indicator" />}
        </button>
        {isAdmin && isText && (
          <button
            onClick={(e) => { e.stopPropagation(); setAccessModalChannel(ch) }}
            className={`sidebar__settings-btn ${(ch.locked || ch.hidden) ? 'sidebar__settings-btn--active' : ''}`}
            title="Channel access settings"
          >
            <Settings size={12} />
          </button>
        )}
        {!isText && voiceUsers.length > 0 && (
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
  }

  const activeServer = servers.find(s => s.id === session?.serverId)

  const hasOwnStatus = !!(session?.user?.status_text || (session?.user?.status_emoji && !session?.user?.status_sticker_id))
  const hasActivity = !(session?.user?.status_text || session?.user?.status_emoji || session?.user?.status_sticker_id) && isTauri() && (shareMediaActivity || shareAppActivity) && session?.user?.id && userActivities[session.user.id]
  const showStatusLine = hasOwnStatus || hasActivity

  return (
    <div ref={sidebarRef} className="sidebar" role="navigation" aria-label="Channels and direct messages">
      {isMobile && onBackToServers && (
        <div className="sidebar__mobile-header">
          <button
            className="sidebar__mobile-back"
            onClick={onBackToServers}
            aria-label="Back to servers"
          >
            <ChevronLeft className="icon-md" />
          </button>
          {activeServer && activeServer.icon && (
            <img src={activeServer.icon} alt="" className="sidebar__mobile-server-icon" />
          )}
          <span className="sidebar__mobile-server-name">
            {activeServer?.name || 'Kizuna'}
          </span>
          <button
            onClick={onOpenMenu}
            className="sidebar__mobile-menu-btn"
            aria-label="Server menu"
          >
            <Ellipsis className="icon-md" />
          </button>
        </div>
      )}
      {!isMobile && (
        <div className="sidebar__header">
          <div className="sidebar__user-row">
            <UserStatusPicker socketRef={socketRef}>
              <Avatar
                src={session?.user?.avatar}
                name={session?.user?.display_name || session?.user?.username}
                size={32}
                stickerId={session?.user?.status_sticker_id}
                serverUrl={session?.url}
                bgColor="var(--brand)"
              />
            </UserStatusPicker>
            <div className={`sidebar__user-info${showStatusLine ? '' : ' sidebar__user-info--centered'}`}>
              <p className="sidebar__user-displayname">{session?.user?.display_name || session?.user?.username}</p>
              <p className="sidebar__user-subtitle">@{session?.user?.username}{isAdmin ? ' · admin' : ''}</p>
              {showStatusLine && (
                <p className="sidebar__user-status">
                  {session?.user?.status_emoji && !session?.user?.status_sticker_id && <span className="sidebar__user-status-emoji">{session.user.status_emoji}</span>}
                  {session?.user?.status_text && <span className="sidebar__user-status-text">{session.user.status_text}</span>}
                  {hasActivity && (
                    <>
                      {userActivities[session.user.id].type === 'game' ? '\u{1F3AE}' : userActivities[session.user.id].type === 'music' ? '\u{1F3B5}' : userActivities[session.user.id].type === 'video' ? '\u25B6' : userActivities[session.user.id].type === 'app' ? '\u{1F4BB}' : '\u25B6'} {userActivities[session.user.id].name}
                    </>
                  )}
                </p>
              )}
            </div>
            <button
              onClick={onOpenMenu}
              className="sidebar__channel-icon"
              style={{ marginLeft: 'auto', fontSize: '14px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}
              title="Server Menu"
              data-tooltip="Server Menu"
            >
              <Ellipsis size={18} />
            </button>
          </div>
        </div>
      )}

      <div className="sidebar__content">
        {/* Render categories with their channels */}
        {categories.sort((a, b) => a.position - b.position).map((cat) => {
          const catChannels = channels.filter(c => c.category_id === cat.id)
          if (catChannels.length === 0) return null
          const isCollapsed = collapsedCategories.has(cat.id)
          return (
            <div key={cat.id} className="sidebar__section">
              <button
                className="sidebar__category-header"
                onClick={() => setCollapsedCategories(prev => {
                  const next = new Set(prev)
                  if (next.has(cat.id)) next.delete(cat.id)
                  else next.add(cat.id)
                  return next
                })}
                title={isCollapsed ? 'Expand' : 'Collapse'}
              >
                <span className={`sidebar__category-arrow${isCollapsed ? ' sidebar__category-arrow--collapsed' : ''}`}>▾</span>
                <span className="sidebar__section-title">{cat.name}</span>
              </button>
              {!isCollapsed && catChannels.map((ch) => renderChannel(ch))}
            </div>
          )
        })}

        {/* Uncategorized text channels */}
        {(() => {
          const uncatText = textChannels.filter(c => !c.category_id)
          if (uncatText.length === 0) return null
          return (
            <div className="sidebar__section">
              <h3 className="sidebar__section-title">Text Channels</h3>
              {uncatText.map((ch) => renderChannel(ch))}
            </div>
          )
        })()}

        {/* Uncategorized voice channels */}
        {(() => {
          const uncatVoice = voiceChannels.filter(c => !c.category_id)
          if (uncatVoice.length === 0) return null
          return (
            <div className="sidebar__section">
              <h3 className="sidebar__section-title">Voice Channels</h3>
              {uncatVoice.map((ch) => renderChannel(ch))}
            </div>
          )
        })()}

        {dmChannels.length > 0 && (
          <div className="sidebar__section">
            <h3 className="sidebar__section-title">Direct Messages</h3>
            {dmChannels.map((dm) => {
              const mentionBadge = mentionCounts[dm.id]
              const unreadOnly = !mentionBadge && unreadCounts[dm.id]
              return (
              <button
                key={dm.id}
                onClick={() => { setActiveDMChannel(dm.id); onOpenChat?.() }}
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

        <div className="sidebar__section">
          <div className="sidebar__section-header">
            <h3 className="sidebar__section-title">Group DMs</h3>
            <button
              onClick={() => setShowCreateGroupDM(true)}
              className="sidebar__section-add-btn"
              title="New Group DM"
            >
              +
            </button>
          </div>
          {groupDMChannels.length === 0 && (
            <p className="sidebar__section-empty">No group chats yet</p>
          )}
          {groupDMChannels.map((gdm) => {
            const mentionBadge = mentionCounts[gdm.id]
            const unreadOnly = !mentionBadge && unreadCounts[gdm.id]
            const nameInitials = gdm.name.slice(0, 2).toUpperCase()
            return (
            <button
              key={gdm.id}
              onClick={() => { setActiveGroupDMChannel(gdm.id); onOpenChat?.() }}
              className={`sidebar__channel ${activeGroupDMChannelId === gdm.id ? 'sidebar__channel--active' : ''}${unreadOnly ? ' sidebar__channel--unread' : ''}`}
            >
              <div className="sidebar__dm-avatar">{
                gdm.avatar ? (
                  <img src={gdm.avatar} alt="" className="sidebar__dm-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                ) : nameInitials
              }</div>
              <span className="sidebar__channel-name">{gdm.name}</span>
              {mentionBadge ? <span className="sidebar__unread-badge">{mentionBadge > 99 ? '99+' : mentionBadge}</span> : unreadOnly ? <span className="sidebar__unread-dot" /> : null}
            </button>
            )
          })}
        </div>

        {isAdmin && (
          <button
            onClick={() => setShowCreateForm((v) => !v)}
            className="sidebar__create-toggle"
          >
            {showCreateForm ? '—' : '+'}
          </button>
        )}
        {showCreateForm && (
          <div className="sidebar__create-menu">
            {session && isAdmin && (
              <form onSubmit={handleCreateChannel} className="sidebar__create-form">
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
        )}
      </div>

      {voicePanel}

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

      {accessModalChannel && createPortal(
        <ChannelAccessModal
          channel={accessModalChannel}
          onClose={() => setAccessModalChannel(null)}
        />,
        document.body,
      )}

      {showCreateGroupDM && createPortal(
        <CreateGroupDMModal onClose={() => setShowCreateGroupDM(false)} />,
        document.body,
      )}
    </div>
  )
}
