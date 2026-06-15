import { Hono } from 'hono'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'

const embedRoutes = new Hono()

embedRoutes.post('/unfurl', authMiddleware, async (c) => {
  const db = getDb()
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

  const urls: string[] = body?.urls || []
  if (!urls.length) return c.json({ embeds: [] })

  const results: Record<string, any> = {}

  for (const url of urls) {
    const cached = db.prepare('SELECT * FROM link_embeds WHERE url = ? AND fetched_at > ?').get(url, Math.floor(Date.now() / 1000) - 86400) as any
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

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Kizuna/1.0 (Link Unfurler)' },
      })
      clearTimeout(timeout)

      if (!res.ok) continue
      const html = await res.text()

      const getMeta = (name: string) => {
        const propMatch = new RegExp(`<meta[^>]+property=["']og:${name}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html)
        if (propMatch) return propMatch[1]
        const nameMatch = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html)
        return nameMatch ? nameMatch[1] : null
      }

      const title = getMeta('title') || html.match(/<title>([^<]+)<\/title>/i)?.[1] || null
      const description = getMeta('description') || null
      const image = getMeta('image') || null
      const siteName = getMeta('site_name') || null
      const favicon = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)?.[1] || null

      try {
        db.prepare(
          'INSERT OR REPLACE INTO link_embeds (url, title, description, image, site_name, favicon, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
