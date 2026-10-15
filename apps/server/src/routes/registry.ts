import { Hono } from 'hono'
import crypto from 'node:crypto'
import { getDb } from '../db'

const STALE_SECONDS = 120
const CLEANUP_INTERVAL_MS = 60_000
// A claimed URL stays reserved for its owner this long after its last
// heartbeat, so a hijacker can't take it over during a short outage.
const OWNER_TTL_SECONDS = 30 * 24 * 3600

const MAX_URL_LENGTH = 512
const MAX_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 500
const MAX_ICON_LENGTH = 256 * 1024

const registryRoutes = new Hono()

// Ownership lives apart from registry_servers because listings are deleted
// after STALE_SECONDS; the claim has to outlive that.
let ownersTableReady = false
function ensureOwnersTable(): void {
  if (ownersTableReady) return
  getDb().exec(`CREATE TABLE IF NOT EXISTS registry_owners (
    url TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen INTEGER NOT NULL
  )`)
  ownersTableReady = true
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Listing ownership protocol:
 *  - The announcer sends `X-Registry-Secret: <secret>` once it holds one, or
 *    `X-Registry-Claim: 1` when it supports secrets but has none yet.
 *  - First claim of a URL: the registry generates a secret, stores only its
 *    hash and returns it once as `{ secret }`. The announcer must persist it.
 *  - Once claimed, every update must carry the matching secret (403 otherwise).
 *  - A secret presented for an unclaimed URL (e.g. the registry's database was
 *    reset) re-establishes the claim with that secret.
 *  - Legacy announcers that send neither header can still update unclaimed
 *    listings, but can never overwrite a claimed one.
 */
registryRoutes.post('/heartbeat', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    url?: unknown
    name?: unknown
    description?: unknown
    icon?: unknown
    passwordProtected?: unknown
    playerCount?: unknown
  } | null
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)

  const url = typeof body.url === 'string' ? body.url.trim().replace(/\/+$/, '') : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!url || !name) {
    return c.json({ error: 'url and name are required' }, 400)
  }
  if (url.length > MAX_URL_LENGTH || !isHttpUrl(url)) {
    return c.json({ error: 'url must be an http(s) URL' }, 400)
  }
  const description =
    typeof body.description === 'string'
      ? body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : ''
  const icon = typeof body.icon === 'string' && body.icon ? body.icon : null
  if (icon && icon.length > MAX_ICON_LENGTH) {
    return c.json({ error: 'icon too large' }, 400)
  }
  const playerCount =
    typeof body.playerCount === 'number' && Number.isFinite(body.playerCount)
      ? Math.max(0, Math.min(Math.floor(body.playerCount), 1_000_000))
      : 0

  const presentedSecret = c.req.header('x-registry-secret') || ''
  const wantsClaim = c.req.header('x-registry-claim') === '1'

  ensureOwnersTable()
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const owner = db.prepare('SELECT secret_hash FROM registry_owners WHERE url = ?').get(url) as
    | { secret_hash: string }
    | undefined

  let issuedSecret: string | undefined
  if (owner) {
    if (!presentedSecret || !secretMatches(presentedSecret, owner.secret_hash)) {
      return c.json({ error: 'This listing is owned by another server' }, 403)
    }
    db.prepare('UPDATE registry_owners SET last_seen = ? WHERE url = ?').run(now, url)
  } else if (presentedSecret) {
    db.prepare(
      'INSERT INTO registry_owners (url, secret_hash, created_at, last_seen) VALUES (?, ?, ?, ?)',
    ).run(url, hashSecret(presentedSecret), now, now)
  } else if (wantsClaim) {
    issuedSecret = crypto.randomBytes(32).toString('hex')
    db.prepare(
      'INSERT INTO registry_owners (url, secret_hash, created_at, last_seen) VALUES (?, ?, ?, ?)',
    ).run(url, hashSecret(issuedSecret), now, now)
  }

  db.prepare(
    `
    INSERT OR REPLACE INTO registry_servers (url, name, description, icon, password_protected, player_count, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    url,
    name.slice(0, MAX_NAME_LENGTH),
    description,
    icon,
    body.passwordProtected === true ? 1 : 0,
    playerCount,
    now,
  )

  return c.json(issuedSecret ? { ok: true, secret: issuedSecret } : { ok: true })
})

registryRoutes.get('/servers', (c) => {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - STALE_SECONDS

  const servers = db
    .prepare(
      `
    SELECT url, name, description, icon, password_protected, player_count, last_heartbeat
    FROM registry_servers
    WHERE last_heartbeat >= ?
    ORDER BY player_count DESC, name ASC
  `,
    )
    .all(cutoff) as {
    url: string
    name: string
    description: string
    icon: string | null
    password_protected: number
    player_count: number
    last_heartbeat: number
  }[]

  return c.json(
    servers.map((s) => ({
      url: s.url,
      name: s.name,
      description: s.description,
      icon: s.icon,
      passwordProtected: s.password_protected === 1,
      playerCount: s.player_count,
    })),
  )
})

function cleanupStaleServers(): void {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - STALE_SECONDS
  db.prepare('DELETE FROM registry_servers WHERE last_heartbeat < ?').run(cutoff)
  ensureOwnersTable()
  db.prepare('DELETE FROM registry_owners WHERE last_seen < ?').run(
    Math.floor(Date.now() / 1000) - OWNER_TTL_SECONDS,
  )
}

export function startRegistryCleanup(): void {
  cleanupStaleServers()
  setInterval(cleanupStaleServers, CLEANUP_INTERVAL_MS).unref()
}

export default registryRoutes
