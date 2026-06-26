import { createLogger } from '../utils/logger'

const log = createLogger('spam')

interface SpamEntry {
  count: number
  resetAt: number
}

interface UserMessage {
  content: string
  time: number
}

interface UserSpamState {
  globalRate: SpamEntry
  channelRates: Map<string, SpamEntry>
  recentMessages: UserMessage[]
  mentionRate: SpamEntry
  violations: number
  lastViolationAt: number
}

interface InMemoryMute {
  channelId: string
  until: number
}

export interface SpamConfig {
  rateMax: number
  rateWindowMs: number
  channelRateMax: number
  channelRateWindowMs: number
  duplicateWindowMs: number
  mentionMax: number
  mentionWindowMs: number
  violationResetMs: number
  autoMuteDurationMs: number
  maxViolations: number
}

export interface SpamCheckResult {
  allowed: boolean
  reason?: 'rate_global' | 'rate_channel' | 'duplicate' | 'mention_spam' | 'muted'
}

const config: SpamConfig = {
  rateMax: 10,
  rateWindowMs: 10_000,
  channelRateMax: 8,
  channelRateWindowMs: 10_000,
  duplicateWindowMs: 30_000,
  mentionMax: 5,
  mentionWindowMs: 10_000,
  violationResetMs: 300_000,
  autoMuteDurationMs: 300_000,
  maxViolations: 5,
}

const MAX_STORE = 50_000
const userStates = new Map<string, UserSpamState>()
const userMutes = new Map<string, InMemoryMute>()

setInterval(() => {
  const now = Date.now()
  for (const [userId, state] of userStates) {
    if (state.lastViolationAt > 0 && now - state.lastViolationAt > config.violationResetMs) {
      userStates.delete(userId)
    }
  }
  for (const [userId, mute] of userMutes) {
    if (mute.until <= now) {
      userMutes.delete(userId)
      log.info(`Auto-mute expired for user ${userId}`)
    }
  }
}, 60_000).unref()

function getOrCreateState(userId: string): UserSpamState {
  let state = userStates.get(userId)
  if (!state) {
    if (userStates.size >= MAX_STORE) {
      userStates.clear()
    }
    const now = Date.now()
    state = {
      globalRate: { count: 0, resetAt: now + config.rateWindowMs },
      channelRates: new Map(),
      recentMessages: [],
      mentionRate: { count: 0, resetAt: now + config.mentionWindowMs },
      violations: 0,
      lastViolationAt: 0,
    }
    userStates.set(userId, state)
  }
  return state
}

function consumeEntry(entry: SpamEntry, amount: number, max: number, windowMs: number): boolean {
  const now = Date.now()
  if (entry.resetAt <= now) {
    entry.count = amount
    entry.resetAt = now + windowMs
    return amount <= max
  }
  if (entry.count + amount > max) return false
  entry.count += amount
  return true
}

function countMentions(content: string): number {
  let count = 0
  count += (content.match(/@everyone\b/g) || []).length
  count += (content.match(/@here\b/g) || []).length
  count += (content.match(/@[\w.-]+/g) || []).length
  return count
}

function recordViolation(state: UserSpamState, userId: string): void {
  const now = Date.now()
  if (now - state.lastViolationAt > config.violationResetMs) {
    state.violations = 0
  }
  state.violations++
  state.lastViolationAt = now

  if (state.violations >= config.maxViolations) {
    userMutes.set(userId, {
      channelId: '*',
      until: now + config.autoMuteDurationMs,
    })
    log.warn(`Auto-muted user ${userId} for ${config.autoMuteDurationMs}ms`)
    state.violations = 0
  }
}

export function checkSpam(
  userId: string,
  channelId: string,
  content: string,
): SpamCheckResult {
  const mute = userMutes.get(userId)
  if (mute && mute.until > Date.now()) {
    return { allowed: false, reason: 'muted' }
  }

  const state = getOrCreateState(userId)

  if (!consumeEntry(state.globalRate, 1, config.rateMax, config.rateWindowMs)) {
    recordViolation(state, userId)
    return { allowed: false, reason: 'rate_global' }
  }

  let chanEntry = state.channelRates.get(channelId)
  if (!chanEntry) {
    chanEntry = { count: 0, resetAt: 0 }
    state.channelRates.set(channelId, chanEntry)
  }
  if (!consumeEntry(chanEntry, 1, config.channelRateMax, config.channelRateWindowMs)) {
    recordViolation(state, userId)
    return { allowed: false, reason: 'rate_channel' }
  }

  const trimmed = content.trim().toLowerCase()
  const cutoff = Date.now() - config.duplicateWindowMs
  state.recentMessages = state.recentMessages.filter(m => m.time > cutoff)
  if (state.recentMessages.some(m => m.content === trimmed)) {
    recordViolation(state, userId)
    return { allowed: false, reason: 'duplicate' }
  }

  const mentionCount = countMentions(content)
  if (mentionCount > 0) {
    if (!consumeEntry(state.mentionRate, mentionCount, config.mentionMax, config.mentionWindowMs)) {
      recordViolation(state, userId)
      return { allowed: false, reason: 'mention_spam' }
    }
  }

  state.recentMessages.push({ content: trimmed, time: Date.now() })

  return { allowed: true }
}

export function clearSpamState(userId: string): void {
  userStates.delete(userId)
  userMutes.delete(userId)
}

export function isUserSpamMuted(userId: string): boolean {
  const mute = userMutes.get(userId)
  return !!mute && mute.until > Date.now()
}

export function applyConfig(overrides: Partial<SpamConfig>): void {
  Object.assign(config, overrides)
}
