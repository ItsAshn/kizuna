import dns from 'node:dns'
import { promisify } from 'node:util'

const resolve4 = promisify(dns.resolve4)
let ipWatcherInterval: ReturnType<typeof setInterval> | null = null

type AddressMode = 'auto' | 'ddns' | 'static'

// resolvePublicAddress overwrites process.env.PUBLIC_ADDRESS with the resolved
// IP, so the operator's original setting has to be captured once, up front.
// Deciding from the resolved value made the watcher think every auto-detect or
// DDNS install was "static" (it saw an IP) and never re-check.
let configuredAddress: string | null = null

function getConfigured(): string {
  if (configuredAddress === null) configuredAddress = (process.env.PUBLIC_ADDRESS || '').trim()
  return configuredAddress
}

export function addressMode(configured: string): AddressMode {
  if (!configured) return 'auto'
  if (configured === 'localhost') return 'static'
  // A hostname (DDNS) starts with a letter and isn't an IPv6 literal.
  if (/^[a-zA-Z]/.test(configured) && !configured.includes(':')) return 'ddns'
  return 'static'
}

const LOOPBACK_FALLBACK = '127.0.0.1'

export async function resolvePublicAddress(): Promise<void> {
  const configured = getConfigured()
  const mode = addressMode(configured)
  const previous = process.env.PUBLIC_ADDRESS

  if (mode === 'auto') {
    const detected = await detectPublicIp()
    if (detected) {
      process.env.PUBLIC_ADDRESS = detected
      return
    }
    // Keep the last good address on a transient failure; only fall back to
    // loopback when there has never been one, and say so loudly, because
    // voice will then only work for clients on this machine.
    if (previous && previous !== LOOPBACK_FALLBACK) {
      console.error(
        `[!] Public IP auto-detection failed; keeping the last known address ${previous}.`,
      )
      return
    }
    console.error(
      `[!] Public IP auto-detection failed (all lookup services unreachable). Falling back to ${LOOPBACK_FALLBACK}.`,
    )
    console.error(
      '[!] Voice will only work for clients on this machine. Set PUBLIC_ADDRESS explicitly to fix this.',
    )
    process.env.PUBLIC_ADDRESS = LOOPBACK_FALLBACK
    return
  }

  if (mode === 'ddns') {
    try {
      const addresses = await resolve4(configured)
      if (addresses.length > 0) {
        process.env.PUBLIC_ADDRESS = addresses[0]
        return
      }
    } catch {
      // handled below
    }
    if (previous && previous !== configured) {
      console.error(
        `[!] Could not resolve DDNS hostname ${configured}; keeping the last known address ${previous}.`,
      )
      return
    }
    console.error(
      `[!] Could not resolve DDNS hostname ${configured}; announcing the hostname as-is.`,
    )
    process.env.PUBLIC_ADDRESS = configured
    return
  }

  // Static IP — use as-is
  process.env.PUBLIC_ADDRESS = configured

  if (configured === '127.0.0.1' || configured === '::1' || configured === 'localhost') {
    console.warn('[!] PUBLIC_ADDRESS is set to a loopback address (127.0.0.1 / localhost).')
    console.warn(
      '[!] This means voice channels will ONLY work for clients running on the same machine as the server.',
    )
    console.warn(
      "[!] For Caddy/HTTPS or remote access, set PUBLIC_ADDRESS to your server's public IP or leave it blank for auto-detection.",
    )
    console.warn('[!] See the .env file for the three supported modes.')
  }
}

export function startIpWatcher(): void {
  // Only auto-detect and DDNS modes can change at runtime.
  if (addressMode(getConfigured()) === 'static') return
  if (ipWatcherInterval) return

  const interval = parseInt(process.env.IP_CHECK_INTERVAL || '300', 10) * 1000
  ipWatcherInterval = setInterval(async () => {
    try {
      const oldAddress = process.env.PUBLIC_ADDRESS
      await resolvePublicAddress()
      const newAddress = process.env.PUBLIC_ADDRESS
      if (oldAddress !== newAddress) {
        console.log(`[i] Public address changed: ${oldAddress} → ${newAddress}`)
      }
    } catch (err) {
      console.error('[!] Public address check failed:', err instanceof Error ? err.message : err)
    }
  }, interval).unref()
}

export function stopIpWatcher(): void {
  if (ipWatcherInterval) {
    clearInterval(ipWatcherInterval)
    ipWatcherInterval = null
  }
}

async function detectPublicIp(): Promise<string | null> {
  const services = ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip']

  for (const url of services) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)
      if (res.ok) {
        const ip = (await res.text()).trim()
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip
      }
    } catch {
      continue
    }
  }

  return null
}
