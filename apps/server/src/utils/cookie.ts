import type { Context } from 'hono'

// Secure must follow the actual transport, not NODE_ENV: the Docker image is
// served over HTTPS by Caddy, but a plain-HTTP LAN install also runs in
// production mode, and a Secure cookie there silently breaks web logins.
export function isHttpsRequest(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')
  if (proto) return proto.split(',')[0]?.trim() === 'https'
  return new URL(c.req.url).protocol === 'https:'
}

export function sessionCookie(c: Context, token: string): string {
  return `kizuna_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${isHttpsRequest(c) ? '; Secure' : ''}`
}
