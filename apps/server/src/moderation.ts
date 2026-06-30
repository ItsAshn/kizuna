import { getDb } from './db'

const PROFANITY_LIST = [
  'anal', 'anus', 'arse', 'ass', 'ballsack', 'bastard', 'bitch', 'biatch',
  'blowjob', 'blow job', 'bollock', 'bollok', 'boner', 'boob', 'bugger',
  'bum', 'butt', 'buttplug', 'clitoris', 'cock', 'coon', 'crap', 'cunt',
  'damn', 'dick', 'dildo', 'dyke', 'fag', 'faggot', 'fanny', 'feck',
  'fellate', 'fellatio', 'felching', 'fuck', 'fudgepacker', 'fudge packer',
  'flange', 'goddamn', 'god damn', 'hell', 'homo', 'jerk', 'jizz',
  'knobend', 'knob end', 'labia', 'muff', 'nigger', 'nigga', 'nutsack',
  'penis', 'piss', 'prick', 'pube', 'pussy', 'queer', 'scrotum', 'sex',
  'shit', 'shite', 'slut', 'smegma', 'spunk', 'tit', 'tosser', 'turd',
  'twat', 'vagina', 'wank', 'whore',
]

const escapedList = PROFANITY_LIST.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const profanityRegex = new RegExp(`\\b(?:${escapedList.join('|')})\\b`, 'i')

let cachedProfanityEnabled: boolean | null = null
let cachedBlockedWords: string[] | null = null
let cachedBlockedRegex: RegExp | null = null
let settingsCacheAt = 0
const SETTINGS_CACHE_TTL = 30_000

function loadModerationSettings(): void {
  const now = Date.now()
  if (settingsCacheAt && now - settingsCacheAt < SETTINGS_CACHE_TTL) return
  const db = getDb()
  const profanityRow = db.prepare(
    "SELECT value FROM server_settings WHERE key = 'profanity_filter_enabled'",
  ).get() as { value: string } | undefined
  cachedProfanityEnabled = profanityRow?.value === 'true'

  const blockedRow = db.prepare(
    "SELECT value FROM server_settings WHERE key = 'blocked_words'",
  ).get() as { value: string } | undefined
  let blockedWords: string[] = []
  if (blockedRow?.value) {
    try {
      blockedWords = JSON.parse(blockedRow.value)
    } catch { /* ignore */ }
  }
  cachedBlockedWords = Array.isArray(blockedWords) ? blockedWords : []
  if (cachedBlockedWords.length > 0) {
    const escaped = cachedBlockedWords
      .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    cachedBlockedRegex = escaped.length > 0
      ? new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i')
      : null
  } else {
    cachedBlockedRegex = null
  }
  settingsCacheAt = now
}

export function clearModerationCache(): void {
  settingsCacheAt = 0
  cachedProfanityEnabled = null
  cachedBlockedWords = null
  cachedBlockedRegex = null
}

export function checkMessageContent(content: string): { allowed: boolean } {
  loadModerationSettings()

  if (cachedProfanityEnabled && profanityRegex.test(content)) {
    return { allowed: false }
  }

  if (cachedBlockedRegex?.test(content)) {
    return { allowed: false }
  }

  return { allowed: true }
}
