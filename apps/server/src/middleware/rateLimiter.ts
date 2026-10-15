import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, Next } from 'hono'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const MAX_STORE_SIZE = 50_000
const store = new Map<string, RateLimitEntry>()

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key)
  }
}, 60_000).unref()

const TRUST_PROXY = ['true', '1', 'yes', 'on'].includes(
  (process.env.TRUST_PROXY || '').trim().toLowerCase(),
)

// Forwarded headers are client-controlled unless a proxy we trust rewrites
// them, so they are only honoured behind one. The proxy appends the address
// it saw, which makes the LAST entry the trustworthy one; the first entry is
// whatever the client claimed.
export function getClientIp(c: Context): string {
  if (TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for')
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean)
      const last = parts[parts.length - 1]
      if (last) return last
    }
    const real = c.req.header('x-real-ip')
    if (real) return real
  }
  try {
    const addr = getConnInfo(c).remote.address
    if (addr) return addr
  } catch {
    /* not running under @hono/node-server (tests) */
  }
  return 'unknown'
}

function rateLimiter(name: string, maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = getClientIp(c)
    const key = `rl:${name}:${ip}`
    const now = Date.now()
    const entry = store.get(key)

    if (!entry || entry.resetAt <= now) {
      if (store.size >= MAX_STORE_SIZE) {
        const oldestKeys = Array.from(store.keys()).slice(0, Math.floor(MAX_STORE_SIZE * 0.1))
        for (const k of oldestKeys) store.delete(k)
      }
      store.set(key, { count: 1, resetAt: now + windowMs })
      await next()
      return
    }

    if (entry.count >= maxRequests) {
      return c.json({ ok: false, error: 'Too many requests. Please try again later.' }, 429)
    }

    entry.count++
    await next()
  }
}

export const authLimiter = rateLimiter('auth', 120, 60_000)
export const sensitiveAuthLimiter = rateLimiter('sensitive-auth', 30, 60_000)
export const messageLimiter = rateLimiter('message', 120, 60_000)
export const uploadLimiter = rateLimiter('upload', 60, 60_000)
export const apiLimiter = rateLimiter('api', 300, 60_000)
export const verifyLimiter = rateLimiter('verify', 30, 60_000)
// Serving media (attachment downloads, gif thumbnails) — a single gif-heavy
// channel can legitimately trigger hundreds of image GETs per minute.
export const mediaLimiter = rateLimiter('media', 600, 60_000)
