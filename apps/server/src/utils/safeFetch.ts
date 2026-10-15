import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { LookupFunction } from 'node:net'

/**
 * Server-side fetch for URLs that a user (or a remote server) controls.
 *
 * Plain `fetch(userUrl)` is an SSRF primitive: it will happily talk to
 * 127.0.0.1, the cloud metadata endpoint, or anything on the host's LAN, and a
 * hostname that resolves to a public address at check time can resolve to a
 * private one at connect time (DNS rebinding). This module:
 *
 * - accepts only http(s) URLs without embedded credentials,
 * - resolves the hostname once, rejects it if ANY address is non-public, and
 *   pins the TCP connection to the vetted address (Host/SNI stay the name),
 * - follows redirects manually, re-validating every hop,
 * - enforces an overall timeout and a response-size cap.
 */

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_URL'
      | 'BLOCKED_SCHEME'
      | 'CREDENTIALS'
      | 'BLOCKED_ADDRESS'
      | 'DNS'
      | 'TOO_MANY_REDIRECTS'
      | 'TOO_LARGE'
      | 'TIMEOUT'
      | 'NETWORK',
  ) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

const v4Blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4],
  ['240.0.0.0', 4], // includes 255.255.255.255
] as const) {
  v4Blocked.addSubnet(net, prefix, 'ipv4')
}

const v6Blocked = new BlockList()
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
  ['64:ff9b:1::', 48], // local-use NAT64
] as const) {
  v6Blocked.addSubnet(net, prefix, 'ipv6')
}

/** Parses a textual IPv6 address into 8 16-bit groups. Returns null if malformed. */
function parseIPv6(input: string): number[] | null {
  let s = input
  // Embedded dotted-quad tail (::ffff:127.0.0.1) → two hex groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number)
    if (o.some((n) => n > 255)) return null
    const hi = ((o[0]! << 8) | o[1]!).toString(16)
    const lo = ((o[2]! << 8) | o[3]!).toString(16)
    s = s.slice(0, dotted.index) + `${hi}:${lo}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parse(halves[0]!)
  const tail = halves.length === 2 ? parse(halves[1]!) : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/**
 * True when `ip` is not a publicly routable unicast address (or is not an IP at
 * all — this fails closed). Accepts bracketed IPv6 and zone ids. IPv6 forms
 * that embed an IPv4 address (mapped, compatible, SIIT, NAT64 64:ff9b::/96,
 * 6to4) are judged by the embedded IPv4 address.
 */
export function isBlockedAddress(ip: string): boolean {
  let addr = ip.trim()
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  const zone = addr.indexOf('%')
  if (zone !== -1) addr = addr.slice(0, zone)

  const family = isIP(addr)
  if (family === 4) return v4Blocked.check(addr, 'ipv4')
  if (family !== 6) return true

  const g = parseIPv6(addr)
  if (!g) return true

  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)

  // ::/96 — IPv4-compatible (deprecated) plus :: and ::1.
  if (zeros(0, 6)) return true
  // ::ffff:0:0/96 — IPv4-mapped.
  if (zeros(0, 5) && g[5] === 0xffff) return v4Blocked.check(v4FromGroups(g[6]!, g[7]!), 'ipv4')
  // ::ffff:0:0:0/96 — IPv4-translated (SIIT).
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) {
    return v4Blocked.check(v4FromGroups(g[6]!, g[7]!), 'ipv4')
  }
  // 64:ff9b::/96 — well-known NAT64 prefix.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) {
    return v4Blocked.check(v4FromGroups(g[6]!, g[7]!), 'ipv4')
  }
  // 2002::/16 — 6to4, IPv4 in groups 1-2.
  if (g[0] === 0x2002) return v4Blocked.check(v4FromGroups(g[1]!, g[2]!), 'ipv4')

  const canonical = g.map((x) => x.toString(16)).join(':')
  return v6Blocked.check(canonical, 'ipv6')
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
])

export interface UrlCheckOptions {
  /** Skip the address/hostname checks (scheme and credential checks still apply). */
  allowPrivate?: boolean
}

/** Strips the brackets WHATWG URL keeps around IPv6 hostnames. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * Synchronous URL vetting: scheme, credentials, and — for literal IPs and
 * well-known local names — the address. Hostnames that need DNS are NOT
 * vetted here; `safeFetch` resolves and checks them at connect time, which is
 * the authoritative check. Throws SafeFetchError; returns the parsed URL.
 */
export function assertPublicUrl(input: string | URL, opts: UrlCheckOptions = {}): URL {
  let url: URL
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href)
  } catch {
    throw new SafeFetchError('not a valid URL', 'INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('url must be http or https', 'BLOCKED_SCHEME')
  }
  if (url.username || url.password) {
    throw new SafeFetchError('url must not contain credentials', 'CREDENTIALS')
  }
  if (!url.hostname) throw new SafeFetchError('url has no host', 'INVALID_URL')
  if (opts.allowPrivate) return url

  const host = bareHostname(url).replace(/\.$/, '')
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new SafeFetchError(`"${host}" is a local address`, 'BLOCKED_ADDRESS')
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new SafeFetchError(`"${host}" is a private address`, 'BLOCKED_ADDRESS')
  }
  return url
}

interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/**
 * Resolves `hostname` and rejects it if any of its addresses is non-public
 * (checking all of them stops a name that round-robins public/private).
 */
async function resolveVetted(hostname: string, allowPrivate: boolean): Promise<ResolvedAddress> {
  const literal = isIP(hostname)
  if (literal) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw new SafeFetchError(`"${hostname}" is a private address`, 'BLOCKED_ADDRESS')
    }
    return { address: hostname, family: literal as 4 | 6 }
  }

  let addrs: { address: string; family: number }[]
  try {
    addrs = await dnsLookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new SafeFetchError(`could not resolve "${hostname}"`, 'DNS')
  }
  if (addrs.length === 0) throw new SafeFetchError(`could not resolve "${hostname}"`, 'DNS')
  if (!allowPrivate) {
    for (const a of addrs) {
      if (isBlockedAddress(a.address)) {
        throw new SafeFetchError(`"${hostname}" resolves to a private address`, 'BLOCKED_ADDRESS')
      }
    }
  }
  const first = addrs[0]!
  return { address: first.address, family: first.family === 6 ? 6 : 4 }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface SafeFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  signal?: AbortSignal
  /** Bypass the private-address checks (e.g. ALLOW_PRIVATE_WEBHOOK_TARGETS). */
  allowPrivate?: boolean
  /** Response body cap in bytes. Default 512 KiB. */
  maxBytes?: number
  /** When true, a body over maxBytes is truncated instead of throwing. */
  truncate?: boolean
  /** Overall deadline across all redirects. Default 8000 ms. */
  timeoutMs?: number
  /** Default 3. 0 returns the 3xx response as-is. */
  maxRedirects?: number
}

export interface SafeFetchResponse {
  status: number
  ok: boolean
  headers: Headers
  /** Final URL after redirects. */
  url: string
  body: Buffer
  text(): string
  json<T = unknown>(): T
}

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization']

interface RawResponse {
  status: number
  headers: Headers
  body: Buffer
}

function requestOnce(
  url: URL,
  pinned: ResolvedAddress,
  init: {
    method: string
    headers: Record<string, string>
    body: string | Buffer | undefined
    signal: AbortSignal
    maxBytes: number
    truncate: boolean
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Every connection goes to the address we vetted, never a fresh lookup.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address: pinned.address, family: pinned.family }])
      } else {
        callback(null, pinned.address, pinned.family)
      }
    }

    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: bareHostname(url),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: init.headers,
        lookup,
        // A fresh agent per request: pooled sockets must never be shared across
        // differently-vetted targets.
        agent: false,
        // SNI and certificate validation stay on the original hostname.
        servername: isIP(bareHostname(url)) ? undefined : bareHostname(url),
      },
      (res) => {
        const headers = new Headers()
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          try {
            headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
          } catch {
            /* invalid header from the remote — ignore it */
          }
        }
        const status = res.statusCode ?? 0

        const declared = Number(res.headers['content-length'])
        if (!init.truncate && Number.isFinite(declared) && declared > init.maxBytes) {
          res.destroy()
          reject(new SafeFetchError('response too large', 'TOO_LARGE'))
          return
        }

        const chunks: Buffer[] = []
        let size = 0
        let done = false
        res.on('data', (chunk: Buffer) => {
          if (done) return
          size += chunk.length
          if (size > init.maxBytes) {
            done = true
            if (init.truncate) {
              chunks.push(chunk.subarray(0, chunk.length - (size - init.maxBytes)))
              res.destroy()
              resolve({ status, headers, body: Buffer.concat(chunks) })
            } else {
              res.destroy()
              reject(new SafeFetchError('response too large', 'TOO_LARGE'))
            }
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (done) return
          done = true
          resolve({ status, headers, body: Buffer.concat(chunks) })
        })
        res.on('error', (err) => {
          if (done) return
          done = true
          reject(toNetworkError(err, init.signal))
        })
      },
    )

    const onAbort = () => req.destroy(new SafeFetchError('request timed out', 'TIMEOUT'))
    if (init.signal.aborted) {
      onAbort()
    } else {
      init.signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => init.signal.removeEventListener('abort', onAbort))
    }

    req.on('error', (err) => reject(toNetworkError(err, init.signal)))
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

function toNetworkError(err: unknown, signal: AbortSignal): SafeFetchError {
  if (err instanceof SafeFetchError) return err
  if (signal.aborted) return new SafeFetchError('request timed out', 'TIMEOUT')
  return new SafeFetchError(err instanceof Error ? err.message : String(err), 'NETWORK')
}

/**
 * SSRF-safe replacement for `fetch` on untrusted URLs. Throws SafeFetchError
 * for blocked targets, timeouts, oversized bodies and network failures; non-2xx
 * statuses are returned, not thrown.
 */
export async function safeFetch(
  input: string | URL,
  init: SafeFetchInit = {},
): Promise<SafeFetchResponse> {
  const allowPrivate = init.allowPrivate ?? false
  const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = init.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const timeout = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout

  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v

  let url = assertPublicUrl(input, { allowPrivate })
  for (let hop = 0; ; hop++) {
    if (signal.aborted) throw new SafeFetchError('request timed out', 'TIMEOUT')
    const pinned = await resolveVetted(bareHostname(url), allowPrivate)
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
    else delete headers['content-length']

    const res = await requestOnce(url, pinned, {
      method,
      headers,
      body,
      signal,
      maxBytes,
      truncate: init.truncate ?? false,
    })

    const location = res.headers.get('location')
    const isRedirect = REDIRECT_STATUSES.has(res.status) && !!location
    if (isRedirect && maxRedirects > 0 && hop >= maxRedirects) {
      throw new SafeFetchError('too many redirects', 'TOO_MANY_REDIRECTS')
    }
    if (!isRedirect || maxRedirects === 0) {
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: res.headers,
        url: url.href,
        body: res.body,
        text: () => res.body.toString('utf8'),
        json: <T>() => JSON.parse(res.body.toString('utf8')) as T,
      }
    }

    let next: URL
    try {
      next = new URL(location!, url)
    } catch {
      throw new SafeFetchError('invalid redirect location', 'INVALID_URL')
    }
    next = assertPublicUrl(next, { allowPrivate })

    if (next.origin !== url.origin) {
      for (const h of SENSITIVE_HEADERS) delete headers[h]
    }
    // fetch semantics: 303 always, and 301/302 for POST, become a bodiless GET.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
      delete headers['content-type']
    }
    url = next
  }
}
