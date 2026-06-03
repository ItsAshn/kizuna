import dns from 'node:dns'
import { promisify } from 'node:util'

const resolve4 = promisify(dns.resolve4)
let ipWatcherInterval: ReturnType<typeof setInterval> | null = null

export async function resolvePublicAddress(): Promise<void> {
  const configured = process.env.PUBLIC_ADDRESS
  if (!configured || configured.trim() === '') {
    // Auto-detect
    const detected = await detectPublicIp()
    process.env.PUBLIC_ADDRESS = detected
    return
  }

  // Check if it's a hostname (DDNS)
  if (/^[a-zA-Z]/.test(configured) && !/^\d+\.\d+/.test(configured)) {
    try {
      const addresses = await resolve4(configured)
      if (addresses.length > 0) {
        process.env.PUBLIC_ADDRESS = addresses[0]
        return
      }
    } catch {
      console.warn(`[i] Could not resolve DDNS hostname: ${configured}`)
    }
  }

  // Already an IP — use as-is
  process.env.PUBLIC_ADDRESS = configured
}

export function startIpWatcher(): void {
  const configured = process.env.PUBLIC_ADDRESS || ''
  // Only watch for auto-detect and DDNS modes
  if (!configured || configured.trim() === '' || /^[a-zA-Z]/.test(configured)) {
    const interval = parseInt(process.env.IP_CHECK_INTERVAL || '300', 10) * 1000
    ipWatcherInterval = setInterval(async () => {
      try {
        const oldAddress = process.env.PUBLIC_ADDRESS
        await resolvePublicAddress()
        const newAddress = process.env.PUBLIC_ADDRESS
        if (oldAddress !== newAddress) {
          console.log(`[i] Public address changed: ${oldAddress} → ${newAddress}`)
        }
      } catch {
        // Ignore errors in watcher
      }
    }, interval).unref()
  }
}

export function stopIpWatcher(): void {
  if (ipWatcherInterval) {
    clearInterval(ipWatcherInterval)
    ipWatcherInterval = null
  }
}

async function detectPublicIp(): Promise<string> {
  const services = [
    'https://api.ipify.org',
    'https://icanhazip.com',
    'https://ifconfig.me/ip',
  ]

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

  return '127.0.0.1'
}
