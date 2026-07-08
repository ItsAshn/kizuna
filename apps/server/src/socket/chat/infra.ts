import type { Socket } from 'socket.io'
import Database from 'better-sqlite3'
import { getDb } from '../../db'

const stmtCache = new Map<string, Database.Statement>()
export function prep(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql)
  if (!stmt) {
    stmt = getDb().prepare(sql)
    stmtCache.set(sql, stmt)
  }
  return stmt
}

const MAX_SOCKET_RATE_STORE = 50_000
const socketRateLimits = new Map<string, { count: number; resetAt: number }>()

export function checkSocketRateLimit(socket: Socket, event: string, max: number, windowMs: number): boolean {
  const key = `${socket.id}:${event}`
  const now = Date.now()
  const entry = socketRateLimits.get(key)
  if (!entry || entry.resetAt <= now) {
    if (socketRateLimits.size >= MAX_SOCKET_RATE_STORE) {
      const oldestKeys = Array.from(socketRateLimits.keys()).slice(0, Math.floor(MAX_SOCKET_RATE_STORE * 0.1))
      for (const k of oldestKeys) socketRateLimits.delete(k)
    }
    socketRateLimits.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= max) return false
  entry.count++
  return true
}

export function clearSocketRateLimits(socketId: string): void {
  for (const key of socketRateLimits.keys()) {
    if (key.startsWith(`${socketId}:`)) socketRateLimits.delete(key)
  }
}

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of socketRateLimits) {
    if (entry.resetAt <= now) socketRateLimits.delete(key)
  }
}, 60_000).unref()

export const dmCalls = new Map<
  string,
  {
    dmChannelId: string
    callerId: string
    callerUsername: string
    calleeId: string
    calleeUsername: string
    status: 'ringing' | 'active'
    startedAt: number
  }
>()

export const groupDMCalls = new Map<
  string,
  {
    channelId: string
    callerId: string
    callerUsername: string
    status: 'ringing' | 'active'
    startedAt: number
  }
>()

setInterval(() => {
  const now = Date.now()
  const staleTimeout = 300_000
  for (const [key, call] of dmCalls) {
    if (call.status === 'ringing' && now - call.startedAt > staleTimeout) dmCalls.delete(key)
  }
  for (const [key, call] of groupDMCalls) {
    if (call.status === 'ringing' && now - call.startedAt > staleTimeout) groupDMCalls.delete(key)
  }
}, 60_000).unref()

export interface MentionResult {
  type: 'everyone' | 'here' | 'user' | 'role';
  target: string | null;
}

export interface ProcessMentionsMessage {
  id: string
  channel_id: string
  author_id?: string
  user_id?: string
  author_username?: string
  username?: string
  content: string
}

export interface MessageRow {
  id: string
  channel_id: string
  author_id: string
  author_username: string
  content: string
  created_at: number
  reply_to_message_id: string | null
  reply_to_username: string | null
  reply_to_content: string | null
  edited_at: number | null
  display_name: string | null
  avatar: string | null
}

export type UserStatus = 'online' | 'idle' | 'busy' | 'offline' | 'invisible'

export interface UserActivity {
  type: 'game' | 'music' | 'video' | 'other'
  name: string
  details?: string
  state?: string
  timestamps?: { start?: number }
}

export const userConnections = new Map<string, Set<string>>()
export const userStatuses = new Map<string, UserStatus>()
export const userActivities = new Map<string, UserActivity>()
