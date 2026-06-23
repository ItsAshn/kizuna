import type { EnvConfig } from './config'

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

export function startHeartbeat(
  config: EnvConfig,
  getPlayerCount: () => number,
  getServerInfo: () => { name: string; description: string; passwordProtected: boolean; icon: string | null },
): void {
  const announceUrl = config.ANNOUNCE_URL || 'https://server.use-kizuna.com'
  const serverUrl = buildServerUrl(config)

  async function sendHeartbeat(): Promise<void> {
    try {
      const info = getServerInfo()
      await fetch(`${normalizeUrl(announceUrl)}/api/registry/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    } catch {
      // silently ignore — registry may be temporarily unreachable
    }
  }

  sendHeartbeat()
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref()
}
