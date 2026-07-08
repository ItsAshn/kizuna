import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes } from 'node:crypto'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { sensitiveAuthLimiter } from '../middleware/rateLimiter'
import { getAuth } from '../utils/auth'

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '')
}

const TOKEN_TTL_SECONDS = 300
const CLEANUP_INTERVAL_MS = 60_000

const identityLinkRoutes = new Hono()

identityLinkRoutes.post('/identity-link/initiate', authMiddleware, (c) => {
  const nonce = randomBytes(32).toString('hex')
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  return c.json({ nonce, expiresAt })
})

identityLinkRoutes.post('/identity-link/confirm', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { requestingServer, nonce } = await c.req.json() as { requestingServer?: string; nonce?: string }

  if (!requestingServer?.trim() || !nonce?.trim()) {
    return c.json({ error: 'requestingServer and nonce are required' }, 400)
  }

  const db = getDb()
  const user = db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(auth.userId) as { username: string; display_name: string } | undefined
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const token = randomBytes(32).toString('hex')
  const now = Math.floor(Date.now() / 1000)

  db.prepare(
    'INSERT INTO verification_tokens (token, user_id, username, display_name, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(token, auth.userId, user.username, user.display_name, normalizeUrl(requestingServer.trim()), now)

  return c.json({ verificationToken: token })
})

identityLinkRoutes.get('/identity-link/verify/:token', (c) => {
  const token = c.req.param('token') || ''
  if (!token) {
    return c.json({ valid: false, error: 'Token is required' }, 400)
  }

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const row = db.prepare(
    'SELECT token, user_id, username, display_name, created_at, used FROM verification_tokens WHERE token = ?',
  ).get(token) as { token: string; user_id: string; username: string; display_name: string; created_at: number; used: number } | undefined

  if (!row) {
    return c.json({ valid: false, error: 'Token not found' }, 404)
  }

  if (row.used === 1) {
    return c.json({ valid: false, error: 'Token already used' }, 400)
  }

  if (row.created_at + TOKEN_TTL_SECONDS < now) {
    db.prepare('UPDATE verification_tokens SET used = 1 WHERE token = ?').run(token)
    return c.json({ valid: false, error: 'Token expired' }, 400)
  }

  db.prepare('UPDATE verification_tokens SET used = 1 WHERE token = ?').run(token)

  return c.json({
    valid: true,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
  })
})

identityLinkRoutes.post('/identity-link/complete', sensitiveAuthLimiter, authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { linkedServerUrl, verificationToken } = await c.req.json() as { linkedServerUrl?: string; verificationToken?: string }

  if (!linkedServerUrl?.trim() || !verificationToken?.trim()) {
    return c.json({ error: 'linkedServerUrl and verificationToken are required' }, 400)
  }

  const serverUrl = normalizeUrl(linkedServerUrl.trim())

  try {
    const response = await fetch(`${serverUrl}/api/auth/identity-link/verify/${encodeURIComponent(verificationToken.trim())}`, {
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) {
      if (response.status === 404) {
        return c.json({ error: 'Verification token not found on the linked server' }, 400)
      }
      const body = await response.json().catch(() => ({}))
      return c.json({ error: (body as { error?: string }).error || 'Verification failed on the linked server' }, 400)
    }

    const result = await response.json() as { valid?: boolean; userId?: string; username?: string; displayName?: string; error?: string }

    if (!result.valid || !result.userId || !result.username) {
      return c.json({ error: result.error || 'Verification failed' }, 400)
    }

    const db = getDb()
    const id = uuidv4()
    const now = Math.floor(Date.now() / 1000)

    try {
      db.prepare(
        'INSERT INTO identity_links (id, user_id, linked_server_url, linked_user_id, linked_username, public, linked_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      ).run(id, auth.userId, serverUrl, result.userId, result.username, now)
    } catch (err: unknown) {
      if (err instanceof Error && err.message?.includes('UNIQUE')) {
        return c.json({ error: 'This server is already linked to your account' }, 409)
      }
      throw err
    }

    const link = db.prepare(
      'SELECT id, linked_server_url, linked_user_id, linked_username, public, linked_at FROM identity_links WHERE id = ?',
    ).get(id) as { id: string; linked_server_url: string; linked_user_id: string; linked_username: string; public: number; linked_at: number }

    return c.json({
      linked_identity: {
        id: link.id,
        linked_server_url: link.linked_server_url,
        linked_user_id: link.linked_user_id,
        linked_username: link.linked_username,
        public: link.public === 1,
        linked_at: link.linked_at,
      },
    }, 201)
  } catch (err: unknown) {
    if (err instanceof TypeError && err.message === 'fetch failed') {
      return c.json({ error: 'Could not reach the linked server' }, 400)
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return c.json({ error: 'Timed out reaching the linked server' }, 400)
    }
    console.error('[identity-link] complete error:', err)
    return c.json({ error: 'Server error' }, 500)
  }
})

identityLinkRoutes.get('/identity-links', authMiddleware, (c) => {
  const auth = getAuth(c)
  const db = getDb()

  const links = db.prepare(
    'SELECT id, linked_server_url, linked_user_id, linked_username, public, linked_at FROM identity_links WHERE user_id = ? ORDER BY linked_at DESC',
  ).all(auth.userId) as { id: string; linked_server_url: string; linked_user_id: string; linked_username: string; public: number; linked_at: number }[]

  return c.json({
    linked_identities: links.map((l) => ({
      id: l.id,
      linked_server_url: l.linked_server_url,
      linked_user_id: l.linked_user_id,
      linked_username: l.linked_username,
      public: l.public === 1,
      linked_at: l.linked_at,
    })),
  })
})

identityLinkRoutes.patch('/identity-links/:id/public', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const linkId = c.req.param('id') || ''
  if (!linkId) return c.json({ error: 'Link ID is required' }, 400)

  const { public: isPublic } = await c.req.json() as { public?: boolean }
  if (typeof isPublic !== 'boolean') {
    return c.json({ error: 'public (boolean) is required' }, 400)
  }

  const db = getDb()
  const link = db.prepare('SELECT id FROM identity_links WHERE id = ? AND user_id = ?').get(linkId, auth.userId) as { id: string } | undefined
  if (!link) return c.json({ error: 'Identity link not found' }, 404)

  db.prepare('UPDATE identity_links SET public = ? WHERE id = ?').run(isPublic ? 1 : 0, linkId)
  return c.json({ ok: true })
})

identityLinkRoutes.delete('/identity-links/:id', authMiddleware, (c) => {
  const auth = getAuth(c)
  const linkId = c.req.param('id') || ''
  if (!linkId) return c.json({ error: 'Link ID is required' }, 400)

  const db = getDb()
  const link = db.prepare('SELECT id FROM identity_links WHERE id = ? AND user_id = ?').get(linkId, auth.userId) as { id: string } | undefined
  if (!link) return c.json({ error: 'Identity link not found' }, 404)

  db.prepare('DELETE FROM identity_links WHERE id = ?').run(linkId)
  return c.json({ ok: true })
})

function cleanupExpiredTokens(): void {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - TOKEN_TTL_SECONDS
  db.prepare('DELETE FROM verification_tokens WHERE created_at < ? AND used = 0').run(cutoff)
  db.prepare('DELETE FROM verification_tokens WHERE used = 1').run()
}

export function startIdentityLinkCleanup(): void {
  cleanupExpiredTokens()
  setInterval(cleanupExpiredTokens, CLEANUP_INTERVAL_MS).unref()
}

export default identityLinkRoutes
