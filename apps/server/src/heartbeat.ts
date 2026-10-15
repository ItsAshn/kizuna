import type { EnvConfig } from './config'
import { getDb } from './db'

const HEARTBEAT_INTERVAL_MS = 60_000

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function buildServerUrl(config: EnvConfig): string {
  if (config.SERVER_URL) return normalizeUrl(config.SERVER_URL)
  const publicAddress = process.env.PUBLIC_ADDRESS || 'localhost'
  const port = process.env.SERVER_PORT || '5000'
  const proto = publicAddress === 'localhost' || publicAddress === '127.0.0.1' ? 'http' : 'https'
  return `${proto}://${publicAddress}:${port}`
}

// The registry hands out a secret the first time this server claims its
// listing; it must be sent on every later heartbeat or updates are refused.
// Stored per registry URL in server_settings so it survives restarts.
function secretKey(announceUrl: string): string {
  return `registry_secret:${announceUrl}`
}

function loadRegistrySecret(announceUrl: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT value FROM server_settings WHERE key = ?')
      .get(secretKey(announceUrl)) as { value: string } | undefined
    return row?.value || null
  } catch {
    return null
  }
}

function saveRegistrySecret(announceUrl: string, secret: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)')
    .run(secretKey(announceUrl), secret)
}

export function startHeartbeat(
  config: EnvConfig,
  getPlayerCount: () => number,
  getServerInfo: () => {
    name: string
    description: string
    passwordProtected: boolean
    icon: string | null
  },
): void {
  const announceUrl = normalizeUrl(config.ANNOUNCE_URL || 'https://server.use-kizuna.com')
  const serverUrl = buildServerUrl(config)
  let warnedRejected = false

  async function sendHeartbeat(): Promise<void> {
    try {
      const info = getServerInfo()
      const secret = loadRegistrySecret(announceUrl)
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (secret) headers['X-Registry-Secret'] = secret
      else headers['X-Registry-Claim'] = '1'
      const res = await fetch(`${announceUrl}/api/registry/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url: serverUrl,
          name: info.name,
          description: info.description,
          icon: info.icon,
          passwordProtected: info.passwordProtected,
          playerCount: getPlayerCount(),
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 403) {
        if (!warnedRejected) {
          console.warn(
            `[heartbeat] Registry ${announceUrl} refused the listing for ${serverUrl}: it is claimed by another secret`,
          )
          warnedRejected = true
        }
        return
      }
      if (!res.ok) return
      const data = (await res.json().catch(() => null)) as { secret?: unknown } | null
      if (typeof data?.secret === 'string' && data.secret) {
        saveRegistrySecret(announceUrl, data.secret)
      }
    } catch {
      // silently ignore — registry may be temporarily unreachable
    }
  }

  sendHeartbeat()
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref()
}
