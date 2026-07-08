import type { Server, Socket } from 'socket.io'
import { getDb } from '../../db'
import { getUserPermissions, hasPermission } from '../../middleware/auth'
import { dmCalls, groupDMCalls } from './infra'
import { getSocketUserId, getSocketUsername } from './helpers'

export function registerCallHandlers(io: Server, socket: Socket): void {
  const userId = getSocketUserId(socket)
  const username = getSocketUsername(socket)

  socket.on('dm:call:start', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId || !username) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to start DM calls' })
      return
    }
    const db = getDb()
    const dmChannel = db.prepare(
      'SELECT * FROM dm_channels WHERE id = ? AND (user1_id = ? OR user2_id = ?)'
    ).get(dmChannelId, userId, userId) as { id: string; user1_id: string; user2_id: string } | undefined
    if (!dmChannel) {
      if (typeof callback === 'function') callback({ error: 'DM channel not found' })
      return
    }
    const existing = [...dmCalls.values()].find(
      c => c.dmChannelId === dmChannelId && c.status !== 'active'
    )
    if (existing) {
      if (typeof callback === 'function') callback({ error: 'A call is already in progress' })
      return
    }
    const calleeId = dmChannel.user1_id === userId ? dmChannel.user2_id : dmChannel.user1_id
    const calleeRow = db.prepare('SELECT username FROM users WHERE id = ?').get(calleeId) as { username: string } | undefined
    const calleeUsername = calleeRow?.username || 'Unknown'

    dmCalls.set(dmChannelId, {
      dmChannelId,
      callerId: userId,
      callerUsername: username,
      calleeId,
      calleeUsername,
      status: 'ringing',
      startedAt: Date.now(),
    })

    const calleeSockets = io.sockets.adapter.rooms.get(`user:${calleeId}`)
    if (!calleeSockets || calleeSockets.size === 0) {
      dmCalls.delete(dmChannelId)
      if (typeof callback === 'function') callback({ error: 'User is offline' })
      return
    }

    io.to(`user:${calleeId}`).emit('dm:call:incoming', {
      dmChannelId,
      callerUserId: userId,
      callerUsername: username,
      calleeUserId: calleeId,
      calleeUsername,
    })

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('dm:call:accept', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to accept DM calls' })
      return
    }
    const call = dmCalls.get(dmChannelId)
    if (!call || call.calleeId !== userId) {
      if (typeof callback === 'function') callback({ error: 'No pending call' })
      return
    }
    call.status = 'active'
    io.to(`user:${call.callerId}`).emit('dm:call:accepted', {
      dmChannelId,
      acceptedByUserId: userId,
      acceptedByUsername: username,
    })

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('dm:call:reject', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = dmCalls.get(dmChannelId)
    if (!call) {
      if (typeof callback === 'function') callback({ error: 'No pending call' })
      return
    }
    const isCaller = call.callerId === userId
    const isCallee = call.calleeId === userId
    if (!isCaller && !isCallee) {
      if (typeof callback === 'function') callback({ error: 'Not a participant' })
      return
    }
    const otherUserId = isCaller ? call.calleeId : call.callerId
    io.to(`user:${otherUserId}`).emit('dm:call:rejected', { dmChannelId })
    dmCalls.delete(dmChannelId)

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('dm:call:end', ({ dmChannelId }: { dmChannelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = dmCalls.get(dmChannelId)
    if (!call) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    const isCaller = call.callerId === userId
    const isCallee = call.calleeId === userId
    if (!isCaller && !isCallee) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    const otherUserId = isCaller ? call.calleeId : call.callerId
    io.to(`user:${otherUserId}`).emit('dm:call:ended', { dmChannelId })
    dmCalls.delete(dmChannelId)

    if (typeof callback === 'function') callback({ ok: true })
  })

  // ─── Group DM Voice Calls ──────────────────────────

  socket.on('group-dm:call:start', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId || !username) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to start calls' })
      return
    }
    const db = getDb()
    const isMember = db.prepare(
      'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, userId)
    if (!isMember) {
      if (typeof callback === 'function') callback({ error: 'Not a member of this group' })
      return
    }
    const existing = groupDMCalls.get(channelId)
    if (existing && existing.status === 'ringing') {
      if (typeof callback === 'function') callback({ error: 'A call is already ringing' })
      return
    }

    const otherMembers = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ? AND user_id != ?'
    ).all(channelId, userId) as { user_id: string }[]

    const anyOnline = otherMembers.some(m => {
      const room = io.sockets.adapter.rooms.get(`user:${m.user_id}`)
      return room && room.size > 0
    })
    if (!anyOnline) {
      if (typeof callback === 'function') callback({ error: 'No other members are online' })
      return
    }

    groupDMCalls.set(channelId, {
      channelId,
      callerId: userId,
      callerUsername: username,
      status: 'ringing',
      startedAt: Date.now(),
    })

    for (const m of otherMembers) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:incoming', {
        channelId,
        callerUserId: userId,
        callerUsername: username,
      })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('group-dm:call:accept', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const userInfo = getUserPermissions(userId)
    if (!userInfo || !hasPermission(userInfo, 'initiate_dm_calls')) {
      if (typeof callback === 'function') callback({ error: 'You do not have permission to accept calls' })
      return
    }
    const call = groupDMCalls.get(channelId)
    if (!call) {
      if (typeof callback === 'function') callback({ error: 'No pending call' })
      return
    }

    const db = getDb()
    const isMember = db.prepare(
      'SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, userId)
    if (!isMember) {
      if (typeof callback === 'function') callback({ error: 'Not a member of this group' })
      return
    }

    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:accepted', {
        channelId,
        acceptedByUserId: userId,
        acceptedByUsername: username,
      })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('group-dm:call:reject', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = groupDMCalls.get(channelId)
    if (!call) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    groupDMCalls.delete(channelId)

    const db = getDb()
    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:rejected', { channelId })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })

  socket.on('group-dm:call:end', ({ channelId }: { channelId: string }, callback?: Function) => {
    if (!userId) {
      if (typeof callback === 'function') callback({ error: 'Not authenticated' })
      return
    }
    const call = groupDMCalls.get(channelId)
    if (!call) {
      if (typeof callback === 'function') callback({ ok: true })
      return
    }
    groupDMCalls.delete(channelId)

    const db = getDb()
    const members = db.prepare(
      'SELECT user_id FROM group_dm_members WHERE channel_id = ?'
    ).all(channelId) as { user_id: string }[]

    for (const m of members) {
      io.to(`user:${m.user_id}`).emit('group-dm:call:ended', { channelId })
    }

    if (typeof callback === 'function') callback({ ok: true })
  })
}
