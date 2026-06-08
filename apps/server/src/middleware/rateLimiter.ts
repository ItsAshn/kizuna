import type { Context, Next } from 'hono'
import { createHash } from 'node:crypto'

interface RateLimitEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key)
  }
}, 60_000).unref()

function getClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) {
    const firstIp = xff.split(',')[0]?.trim()
    if (firstIp) return firstIp
  }
  return c.req.header('x-real-ip') || '127.0.0.1'
}

function rateLimiter(maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = getClientIp(c)
    const key = createHash('sha256').update(`rl:${ip}`).digest('hex').slice(0, 24)
    const now = Date.now()
    const entry = store.get(key)

    if (!entry || entry.resetAt <= now) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      await next()
      return
    }

    if (entry.count >= maxRequests) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429)
    }

    entry.count++
    await next()
  }
}

export const authLimiter = rateLimiter(20, 60_000)
export const messageLimiter = rateLimiter(60, 60_000)
export const uploadLimiter = rateLimiter(30, 60_000)
export const apiLimiter = rateLimiter(100, 60_000)
