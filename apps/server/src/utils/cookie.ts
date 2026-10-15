import type { Context } from 'hono'

// Secure must follow the actual transport, not NODE_ENV: the Docker image is
// served over HTTPS by Caddy but never set NODE_ENV, so the flag was missing
// in exactly the deployment that needed it.
export function isHttpsRequest(c: Context): boolean {
  if (process.env.NODE_ENV === 'production') return true
  const proto = c.req.header('x-forwarded-proto')
  if (proto) return proto.split(',')[0]?.trim() === 'https'
  return new URL(c.req.url).protocol === 'https:'
}

export function sessionCookie(c: Context, token: string): string {
  return `kizuna_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${isHttpsRequest(c) ? '; Secure' : ''}`
}
