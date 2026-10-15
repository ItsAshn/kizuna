import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import { safeFetch } from '../utils/safeFetch'

/** Unfurls per request — each one is an outbound fetch, so keep it small. */
const MAX_URLS = 5
const MAX_HTML_BYTES = 512 * 1024

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const embedRoutes = new Hono()

embedRoutes.post('/unfurl', authMiddleware, async (c) => {
  const db = getDb()
  let body: { urls?: string[] }
  try {
    body = (await c.req.json()) as { urls?: string[] }
  } catch {
    return c.json({ error: 'Invalid body' }, 400)
  }

  const rawUrls: unknown[] = Array.isArray(body?.urls) ? body.urls : []
  const urls = [...new Set(rawUrls.filter(isHttpUrl))].slice(0, MAX_URLS)
  if (!urls.length) return c.json({ embeds: [] })

  const results: Record<
    string,
    {
      title: string | null
      description: string | null
      image: string | null
      siteName: string | null
      favicon: string | null
    }
  > = {}

  for (const url of urls) {
    const cached = db
      .prepare('SELECT * FROM link_embeds WHERE url = ? AND fetched_at > ?')
      .get(url, Math.floor(Date.now() / 1000) - 86400) as
      | {
          title: string | null
          description: string | null
          image: string | null
          site_name: string | null
          favicon: string | null
        }
      | undefined
    if (cached) {
      results[url] = {
        title: cached.title,
        description: cached.description,
        image: cached.image,
        siteName: cached.site_name,
        favicon: cached.favicon,
      }
      continue
    }

    const ytMatch = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
    if (ytMatch) {
      try {
        const oembedRes = await safeFetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytMatch[1]}`)}&format=json`,
          { timeoutMs: 5000, maxBytes: 64 * 1024 },
        )
        if (oembedRes.ok) {
          const oembed = oembedRes.json() as { title?: string; thumbnail_url?: string }
          const title = oembed.title || null
          const image = oembed.thumbnail_url || null

          db.prepare(
            'INSERT OR REPLACE INTO link_embeds (url, title, description, image, site_name, favicon, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(
            url,
            title,
            null,
            image,
            'YouTube',
            'https://www.youtube.com/favicon.ico',
            Math.floor(Date.now() / 1000),
          )

          results[url] = {
            title,
            description: null,
            image,
            siteName: 'YouTube',
            favicon: 'https://www.youtube.com/favicon.ico',
          }
          continue
        }
      } catch {
        // oEmbed failed — fall through to generic scraper
      }
    }

    try {
      // safeFetch rejects private/loopback/metadata targets (re-checked on
      // every redirect hop) and pins the connection to the vetted address.
      // Truncating is fine: the meta tags live in <head>.
      const res = await safeFetch(url, {
        timeoutMs: 5000,
        maxBytes: MAX_HTML_BYTES,
        truncate: true,
        headers: { 'User-Agent': 'Kizuna/1.0 (Link Unfurler)' },
      })

      if (!res.ok) continue
      const html = res.text()

      const getMeta = (name: string) => {
        const propMatch = new RegExp(
          `<meta[^>]+property=["']og:${name}["'][^>]+content=["']([^"']+)["']`,
          'i',
        ).exec(html)
        if (propMatch) return propMatch[1]
        const nameMatch = new RegExp(
          `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`,
          'i',
        ).exec(html)
        return nameMatch ? nameMatch[1] : null
      }

      const title = getMeta('title') || html.match(/<title>([^<]+)<\/title>/i)?.[1] || null
      const description = getMeta('description') || null
      const image = getMeta('image') || null
      const siteName = getMeta('site_name') || null
      const favicon =
        html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
        null

      try {
        db.prepare(
          'INSERT OR REPLACE INTO link_embeds (url, title, description, image, site_name, favicon, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(url, title, description, image, siteName, favicon, Math.floor(Date.now() / 1000))
      } catch {}

      results[url] = { title, description, image, siteName, favicon }
    } catch {
      // Skip failed URLs
    }
  }

  return c.json({ embeds: results })
})

export default embedRoutes
export { embedRoutes }
