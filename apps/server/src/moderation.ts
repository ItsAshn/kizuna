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

export function checkMessageContent(content: string): { allowed: boolean } {
  const db = getDb()

  const profanityFilterRow = db.prepare(
    "SELECT value FROM server_settings WHERE key = 'profanity_filter_enabled'",
  ).get() as { value: string } | undefined

  if (profanityFilterRow?.value === 'true') {
    if (profanityRegex.test(content)) {
      return { allowed: false }
    }
  }

  const blockedWordsRow = db.prepare(
    "SELECT value FROM server_settings WHERE key = 'blocked_words'",
  ).get() as { value: string } | undefined

  if (blockedWordsRow?.value) {
    let blockedWords: string[] = []
    try {
      blockedWords = JSON.parse(blockedWordsRow.value)
    } catch { /* ignore invalid JSON */ }
    if (Array.isArray(blockedWords) && blockedWords.length > 0) {
      const escapedWords = blockedWords
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      if (escapedWords.length > 0) {
        const blockedRegex = new RegExp(`\\b(?:${escapedWords.join('|')})\\b`, 'i')
        if (blockedRegex.test(content)) {
          return { allowed: false }
        }
      }
    }
  }

  return { allowed: true }
}
