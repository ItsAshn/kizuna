import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SafeFetchError,
  assertPublicUrl,
  bareHostname,
  isBlockedAddress,
  safeFetch,
} from './safeFetch'

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '172.16.3.4',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::FFFF:A9FE:A9FE',
    '[::ffff:a9fe:a9fe]',
    '0:0:0:0:0:ffff:10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::169.254.169.254',
    '2002:7f00:1::',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888', '64:ff9b::808:808'])(
    'allows %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false)
    },
  )
})

describe('assertPublicUrl', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.5:8080/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fe80::1]/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/', // hex shorthand
    'http://localhost:3000/',
    'http://foo.localhost/',
    'http://printer.local/',
  ])('rejects private target %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrowError(SafeFetchError)
  })

  it('normalises bracketed mapped IPv6 to a blocked address', () => {
    const url = new URL('http://[::ffff:a9fe:a9fe]/')
    expect(isBlockedAddress(bareHostname(url))).toBe(true)
  })

  it.each(['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'data:,hi'])(
    'rejects scheme %s',
    (url) => {
      expect(() => assertPublicUrl(url)).toThrowError(/http or https/)
    },
  )

  it('rejects credentials', () => {
    expect(() => assertPublicUrl('https://user:pw@example.com/')).toThrowError(/credentials/)
  })

  it('rejects garbage', () => {
    expect(() => assertPublicUrl('not a url')).toThrowError(/valid URL/)
  })

  it.each(['https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://example.com/path?q=1'])(
    'accepts %s',
    (url) => {
      expect(assertPublicUrl(url).href).toBe(new URL(url).href)
    },
  )

  it('allowPrivate skips address checks but not scheme checks', () => {
    expect(assertPublicUrl('http://127.0.0.1/', { allowPrivate: true }).hostname).toBe('127.0.0.1')
    expect(() => assertPublicUrl('file:///etc/passwd', { allowPrivate: true })).toThrowError()
  })
})

describe('safeFetch', () => {
  it('refuses a loopback target before connecting', async () => {
    await expect(safeFetch('http://127.0.0.1:1/')).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    })
  })

  it('refuses a hostname that resolves to loopback', async () => {
    // Trailing-dot FQDN form must not slip past the local-name check.
    await expect(safeFetch('http://localhost.:1/')).rejects.toBeInstanceOf(SafeFetchError)
  })
})

describe('safeFetch against a local server (allowPrivate)', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/big') {
        res.end('x'.repeat(4096))
      } else if (req.url === '/to-file') {
        res.writeHead(302, { location: 'file:///etc/passwd' }).end()
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end()
      } else if (req.url === '/hop') {
        res.writeHead(303, { location: '/echo' }).end()
      } else {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ method: req.method, host: req.headers.host }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('fetches and parses JSON', async () => {
    const res = await safeFetch(`${base}/echo`, { allowPrivate: true })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ method: 'GET' })
  })

  it('is blocked without allowPrivate', async () => {
    await expect(safeFetch(`${base}/echo`)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' })
  })

  it('caps the body', async () => {
    await expect(
      safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
    const truncated = await safeFetch(`${base}/big`, {
      allowPrivate: true,
      maxBytes: 100,
      truncate: true,
    })
    expect(truncated.body.length).toBe(100)
  })

  it('re-validates redirect targets', async () => {
    await expect(safeFetch(`${base}/to-file`, { allowPrivate: true })).rejects.toMatchObject({
      code: 'BLOCKED_SCHEME',
    })
  })

  it('limits redirects', async () => {
    await expect(safeFetch(`${base}/loop`, { allowPrivate: true })).rejects.toMatchObject({
      code: 'TOO_MANY_REDIRECTS',
    })
  })

  it('turns a 303 POST into a GET', async () => {
    const res = await safeFetch(`${base}/hop`, { allowPrivate: true, method: 'POST', body: '{}' })
    expect(res.json()).toMatchObject({ method: 'GET' })
    expect(res.url).toBe(`${base}/echo`)
  })
})
