import { Hono } from 'hono'
import { getDb } from '../db'

const STALE_SECONDS = 120
const CLEANUP_INTERVAL_MS = 60_000

const registryRoutes = new Hono()

registryRoutes.post('/heartbeat', async (c) => {
  const body = await c.req.json() as {
    url: string
    name: string
    description?: string
    icon?: string | null
    passwordProtected?: boolean
    playerCount?: number
  }

  if (!body.url?.trim() || !body.name?.trim()) {
    return c.json({ error: 'url and name are required' }, 400)
  }

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  db.prepare(`
    INSERT OR REPLACE INTO registry_servers (url, name, description, icon, password_protected, player_count, last_heartbeat)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    body.url.trim(),
    body.name.trim(),
    (body.description || '').trim(),
    body.icon || null,
    body.passwordProtected ? 1 : 0,
    body.playerCount ?? 0,
    now,
  )

  return c.json({ ok: true })
})

registryRoutes.get('/servers', (c) => {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - STALE_SECONDS

  const servers = db.prepare(`
    SELECT url, name, description, icon, password_protected, player_count, last_heartbeat
    FROM registry_servers
    WHERE last_heartbeat >= ?
    ORDER BY player_count DESC, name ASC
  `).all(cutoff) as {
    url: string
    name: string
    description: string
    icon: string | null
    password_protected: number
    player_count: number
    last_heartbeat: number
  }[]

  return c.json(servers.map((s) => ({
    url: s.url,
    name: s.name,
    description: s.description,
    icon: s.icon,
    passwordProtected: s.password_protected === 1,
    playerCount: s.player_count,
  })))
})

function cleanupStaleServers(): void {
  const db = getDb()
  const cutoff = Math.floor(Date.now() / 1000) - STALE_SECONDS
  db.prepare('DELETE FROM registry_servers WHERE last_heartbeat < ?').run(cutoff)
}

export function startRegistryCleanup(): void {
  cleanupStaleServers()
  setInterval(cleanupStaleServers, CLEANUP_INTERVAL_MS).unref()
}

export default registryRoutes
