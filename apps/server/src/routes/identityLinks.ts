import { Hono } from 'hono'
import type { Context } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { sensitiveAuthLimiter } from '../middleware/rateLimiter'
import { getAuth } from '../utils/auth'
import { createLogger } from '../utils/logger'
import { SafeFetchError, assertPublicUrl, safeFetch } from '../utils/safeFetch'

const log = createLogger('identity-link')

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '')
}

const TOKEN_TTL_SECONDS = 300
const CLEANUP_INTERVAL_MS = 60_000

/*
 * Flow (A = server the user is linking FROM, B = server holding the identity):
 *
 *  1. client → A  POST /identity-link/initiate     A issues a nonce bound to the
 *                                                  calling user (kept in memory).
 *  2. client → B  POST /identity-link/confirm      B stores {token, user, requested_by
 *                 {requestingServer: A, nonce}     = A, nonce} and returns the token.
 *  3. client → A  POST /identity-link/complete     A looks up the nonce IT issued to
 *                 {linkedServerUrl: B, token}      this user and calls B's verify with
 *                                                  ?nonce=&requester=<A's origin>.
 *  4. A → B       GET /identity-link/verify/:token B only vouches if the nonce matches
 *                                                  the one stored with the token and the
 *                                                  requester matches requested_by.
 *
 * So a token on its own is useless: it only redeems on the server it was issued
 * for, for the user who started the link there.
 */

/** A-side: the nonce each user most recently started a link with. */
const pendingNonces = new Map<string, { nonce: string; expiresAt: number }>()

/**
 * verification_tokens predates the nonce binding. Add the column idempotently
 * rather than from the central migration list.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** host[:port] of a server URL, lowercased; null if it isn't an http(s) URL. */
function serverHost(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * This server's public origin as clients see it — what they pass to B as
 * `requestingServer`. SERVER_URL is authoritative; otherwise fall back to the
 * forwarded/Host header of the request.
 */
function ownOrigin(c: Context): string {
  const configured = process.env.SERVER_URL?.trim()
  if (configured && serverHost(configured)) return new URL(configured).origin
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host')
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ||
    new URL(c.req.url).protocol.replace(':', '')
  return host ? `${proto}://${host}` : new URL(c.req.url).origin
}

const identityLinkRoutes = new Hono()

identityLinkRoutes.post('/identity-link/initiate', authMiddleware, (c) => {
  const auth = getAuth(c)
  const nonce = randomBytes(32).toString('hex')
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
  // One link in flight per user: starting again supersedes the previous nonce.
  pendingNonces.set(auth.userId, { nonce, expiresAt })
  return c.json({ nonce, expiresAt })
})

identityLinkRoutes.post('/identity-link/confirm', authMiddleware, async (c) => {
  const auth = getAuth(c)
  const { requestingServer, nonce } = (await c.req.json().catch(() => ({}))) as {
    requestingServer?: unknown
    nonce?: unknown
  }

  if (
    typeof requestingServer !== 'string' ||
    typeof nonce !== 'string' ||
    !requestingServer.trim() ||
    !/^[0-9a-f]{64}$/i.test(nonce.trim())
  ) {
    return c.json({ error: 'requestingServer and nonce are required' }, 400)
  }
  if (!serverHost(requestingServer.trim())) {
    return c.json({ error: 'requestingServer must be an http(s) URL' }, 400)
  }

  const db = getDb()
  const user = db
    .prepare('SELECT username, display_name FROM users WHERE id = ?')
    .get(auth.userId) as { username: string; display_name: string } | undefined
  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  const token = randomBytes(32).toString('hex')
  const now = Math.floor(Date.now() / 1000)

  db.prepare(
    'INSERT INTO verification_tokens (token, user_id, username, display_name, requested_by, nonce, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    token,
    auth.userId,
    user.username,
    user.display_name,
    normalizeUrl(requestingServer.trim()),
    nonce.trim().toLowerCase(),
    now,
  )

  return c.json({ verificationToken: token })
})

// Called server-to-server by the requesting server (unauthenticated by design).
identityLinkRoutes.get('/identity-link/verify/:token', (c) => {
  const token = c.req.param('token') || ''
  if (!token) {
    return c.json({ valid: false, error: 'Token is required' }, 400)
  }
  const nonce = (c.req.query('nonce') || '').toLowerCase()
  const requester = c.req.query('requester') || ''

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const row = db
    .prepare(
      'SELECT token, user_id, username, display_name, requested_by, nonce, created_at, used FROM verification_tokens WHERE token = ?',
    )
    .get(token) as
    | {
        token: string
        user_id: string
        username: string
        display_name: string
        requested_by: string
        nonce: string | null
        created_at: number
        used: number
      }
    | undefined

  if (!row) {
    return c.json({ valid: false, error: 'Token not found' }, 404)
  }

  if (row.used === 1) {
    return c.json({ valid: false, error: 'Token already used' }, 400)
  }

  // Single use regardless of outcome: a token presented with the wrong nonce
  // or by the wrong server has leaked and must not be retried.
  db.prepare('UPDATE verification_tokens SET used = 1 WHERE token = ?').run(token)

  if (row.created_at + TOKEN_TTL_SECONDS < now) {
    return c.json({ valid: false, error: 'Token expired' }, 400)
  }

  const expectedHost = serverHost(row.requested_by)
  if (
    !row.nonce ||
    !nonce ||
    !safeEqual(row.nonce, nonce) ||
    !expectedHost ||
    serverHost(requester) !== expectedHost
  ) {
    log.warn(
      `verify rejected for token issued to ${row.requested_by}: requester=${requester || '(none)'} nonce ${nonce ? 'mismatch' : 'missing'}`,
    )
    return c.json({ valid: false, error: 'Verification failed' }, 400)
  }

  return c.json({
    valid: true,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
  })
})

identityLinkRoutes.post(
  '/identity-link/complete',
  sensitiveAuthLimiter,
  authMiddleware,
  async (c) => {
    const auth = getAuth(c)
    const { linkedServerUrl, verificationToken } = (await c.req.json().catch(() => ({}))) as {
      linkedServerUrl?: unknown
      verificationToken?: unknown
    }

    if (
      typeof linkedServerUrl !== 'string' ||
      typeof verificationToken !== 'string' ||
      !linkedServerUrl.trim() ||
      !verificationToken.trim()
    ) {
      return c.json({ error: 'linkedServerUrl and verificationToken are required' }, 400)
    }

    const pending = pendingNonces.get(auth.userId)
    if (!pending || pending.expiresAt < Math.floor(Date.now() / 1000)) {
      pendingNonces.delete(auth.userId)
      return c.json({ error: 'Link request expired — start linking again' }, 400)
    }

    const serverUrl = normalizeUrl(linkedServerUrl.trim())
    let verifyUrl: URL
    try {
      const base = assertPublicUrl(serverUrl)
      if (base.search || base.hash) throw new SafeFetchError('unexpected query', 'INVALID_URL')
      verifyUrl = new URL(
        `${normalizeUrl(base.href)}/api/auth/identity-link/verify/${encodeURIComponent(verificationToken.trim())}`,
      )
      verifyUrl.searchParams.set('nonce', pending.nonce)
      verifyUrl.searchParams.set('requester', ownOrigin(c))
    } catch {
      return c.json({ error: 'linkedServerUrl must be a public http(s) server URL' }, 400)
    }

    try {
      const response = await safeFetch(verifyUrl, {
        timeoutMs: 8000,
        maxBytes: 16 * 1024,
        maxRedirects: 0,
        headers: { Accept: 'application/json' },
      })

      let result: {
        valid?: boolean
        userId?: unknown
        username?: unknown
        error?: unknown
      } = {}
      try {
        result = response.json()
      } catch {
        /* non-JSON — treated as a failure below */
      }

      if (!response.ok || result.valid !== true) {
        // The remote's error text is attacker-controlled: log it, don't echo it.
        log.warn(
          `verify against ${serverUrl} failed: HTTP ${response.status} ${String(result.error ?? '').slice(0, 200)}`,
        )
        if (response.status === 404) {
          return c.json({ error: 'Verification token not found on the linked server' }, 400)
        }
        return c.json({ error: 'Verification failed on the linked server' }, 400)
      }

      if (
        typeof result.userId !== 'string' ||
        typeof result.username !== 'string' ||
        !result.userId ||
        !result.username ||
        result.userId.length > 128 ||
        result.username.length > 64
      ) {
        log.warn(`verify against ${serverUrl} returned a malformed identity`)
        return c.json({ error: 'Verification failed on the linked server' }, 400)
      }

      // The nonce is spent once the remote has vouched for it.
      pendingNonces.delete(auth.userId)

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

      const link = db
        .prepare(
          'SELECT id, linked_server_url, linked_user_id, linked_username, public, linked_at FROM identity_links WHERE id = ?',
        )
        .get(id) as {
        id: string
        linked_server_url: string
        linked_user_id: string
        linked_username: string
        public: number
        linked_at: number
      }

      return c.json(
        {
          linked_identity: {
            id: link.id,
            linked_server_url: link.linked_server_url,
            linked_user_id: link.linked_user_id,
            linked_username: link.linked_username,
            public: link.public === 1,
            linked_at: link.linked_at,
          },
        },
        201,
      )
    } catch (err: unknown) {
      if (err instanceof SafeFetchError) {
        log.warn(`could not verify against ${serverUrl}: ${err.code} ${err.message}`)
        if (err.code === 'TIMEOUT') {
          return c.json({ error: 'Timed out reaching the linked server' }, 400)
        }
        if (err.code === 'BLOCKED_ADDRESS') {
          return c.json({ error: 'linkedServerUrl must be a public http(s) server URL' }, 400)
        }
        return c.json({ error: 'Could not reach the linked server' }, 400)
      }
      log.error('complete error:', err)
      return c.json({ error: 'Server error' }, 500)
    }
  },
)

identityLinkRoutes.get('/identity-links', authMiddleware, (c) => {
  const auth = getAuth(c)
  const db = getDb()

  const links = db
    .prepare(
      'SELECT id, linked_server_url, linked_user_id, linked_username, public, linked_at FROM identity_links WHERE user_id = ? ORDER BY linked_at DESC',
    )
    .all(auth.userId) as {
    id: string
    linked_server_url: string
    linked_user_id: string
    linked_username: string
    public: number
    linked_at: number
  }[]

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

  const { public: isPublic } = (await c.req.json()) as { public?: boolean }
  if (typeof isPublic !== 'boolean') {
    return c.json({ error: 'public (boolean) is required' }, 400)
  }

  const db = getDb()
  const link = db
    .prepare('SELECT id FROM identity_links WHERE id = ? AND user_id = ?')
    .get(linkId, auth.userId) as { id: string } | undefined
  if (!link) return c.json({ error: 'Identity link not found' }, 404)

  db.prepare('UPDATE identity_links SET public = ? WHERE id = ?').run(isPublic ? 1 : 0, linkId)
  return c.json({ ok: true })
})

identityLinkRoutes.delete('/identity-links/:id', authMiddleware, (c) => {
  const auth = getAuth(c)
  const linkId = c.req.param('id') || ''
  if (!linkId) return c.json({ error: 'Link ID is required' }, 400)

  const db = getDb()
  const link = db
    .prepare('SELECT id FROM identity_links WHERE id = ? AND user_id = ?')
    .get(linkId, auth.userId) as { id: string } | undefined
  if (!link) return c.json({ error: 'Identity link not found' }, 404)

  db.prepare('DELETE FROM identity_links WHERE id = ?').run(linkId)
  return c.json({ ok: true })
})

function cleanupExpiredTokens(): void {
  const nowSec = Math.floor(Date.now() / 1000)
  for (const [userId, entry] of pendingNonces) {
    if (entry.expiresAt < nowSec) pendingNonces.delete(userId)
  }
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
