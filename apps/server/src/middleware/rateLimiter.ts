import type { Context, Next } from 'hono';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const MAX_STORE_SIZE = 50_000;
const store = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }
}, 60_000).unref();

function getClientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const firstIp = xff.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }
  return c.req.header('x-real-ip') || '127.0.0.1';
}

function rateLimiter(name: string, maxRequests: number, windowMs: number) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = getClientIp(c);
    const key = `rl:${name}:${ip}`;
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || entry.resetAt <= now) {
      if (store.size >= MAX_STORE_SIZE) {
        const oldestKeys = Array.from(store.keys()).slice(0, Math.floor(MAX_STORE_SIZE * 0.1))
        for (const k of oldestKeys) store.delete(k)
      }
      store.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (entry.count >= maxRequests) {
      return c.json({ ok: false, error: 'Too many requests. Please try again later.' }, 429);
    }

    entry.count++;
    await next();
  };
}

export const authLimiter = rateLimiter('auth', 120, 60_000);
export const sensitiveAuthLimiter = rateLimiter('sensitive-auth', 30, 60_000);
export const messageLimiter = rateLimiter('message', 120, 60_000);
export const uploadLimiter = rateLimiter('upload', 60, 60_000);
export const apiLimiter = rateLimiter('api', 300, 60_000);
export const verifyLimiter = rateLimiter('verify', 30, 60_000);
// Serving media (attachment downloads, gif thumbnails) — a single gif-heavy
// channel can legitimately trigger hundreds of image GETs per minute.
export const mediaLimiter = rateLimiter('media', 600, 60_000);
