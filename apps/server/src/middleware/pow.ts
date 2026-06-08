import { randomBytes, createHash } from 'node:crypto'

interface PoWChallenge {
  challenge: string
  difficulty: number
  expiresAt: number
}

const DEFAULT_DIFFICULTY = 20
const CHALLENGE_TTL_MS = 300_000
const MAX_DIFFICULTY = 28

const challenges = new Map<string, PoWChallenge>()

setInterval(() => {
  const now = Date.now()
  for (const [key, challenge] of challenges) {
    if (challenge.expiresAt <= now) challenges.delete(key)
  }
}, 60_000).unref()

export function generateChallenge(): PoWChallenge {
  const difficulty = getDifficulty()
  const challenge = randomBytes(32).toString('hex')
  const entry: PoWChallenge = {
    challenge,
    difficulty,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  }
  challenges.set(challenge, entry)
  return entry
}

export function verifyPoW(challenge: string, nonce: string): boolean {
  const entry = challenges.get(challenge)
  if (!entry) return false
  challenges.delete(challenge)
  if (Date.now() > entry.expiresAt) return false
  const hash = createHash('sha256').update(challenge + nonce).digest()
  return countLeadingZeroBits(hash) >= entry.difficulty
}

export function getDifficulty(): number {
  const raw = process.env.POW_DIFFICULTY
  if (raw) {
    const parsed = parseInt(raw, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_DIFFICULTY)
    }
  }
  return DEFAULT_DIFFICULTY
}

function countLeadingZeroBits(buf: Uint8Array): number {
  let bits = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      bits += 8
    } else {
      let mask = 0x80
      while (mask > 0 && (buf[i] & mask) === 0) {
        bits++
        mask >>= 1
      }
      break
    }
  }
  return bits
}
