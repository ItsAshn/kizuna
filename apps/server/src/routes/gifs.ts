import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import AdmZip from 'adm-zip'
import { getDb } from '../db'
import { authMiddleware, isUserAdmin } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const gifRoutes = new Hono()

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const GIFS_DIR = process.env.GIFS_DIR || path.join(UPLOADS_DIR, 'gifs')
const MAX_GIF_SIZE = parseInt(process.env.MAX_GIF_SIZE || '5242880', 10)

const ALLOWED_GIF_EXTS = ['.gif']
const ALLOWED_STICKER_EXTS = ['.gif', '.png', '.webp']

const MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const MAGIC_BYTES: Record<string, number[][]> = {
  '.gif': [[0x47, 0x49, 0x46, 0x38]],
  '.png': [[0x89, 0x50, 0x4E, 0x47]],
  '.webp': [[0x52, 0x49, 0x46, 0x46]],
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function verifyMagicBytes(buffer: Buffer, expectedExtension: string): boolean {
  const signatures = MAGIC_BYTES[expectedExtension]
  if (!signatures) return true
  for (const sig of signatures) {
    if (sig.length > buffer.length) continue
    if (sig.every((b, i) => buffer[i] === b)) return true
  }
  return false
}

if (!fs.existsSync(GIFS_DIR)) {
  fs.mkdirSync(GIFS_DIR, { recursive: true })
}

function gifRowToResponse(row: any): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    display_name: row.display_name,
    category: row.category,
    tags: row.tags,
    pack_name: row.pack_name || null,
    file_url: `/api/gifs/${row.id}/file`,
    file_size: row.file_size,
    width: row.width || null,
    height: row.height || null,
    created_at: row.created_at,
  }
}

function saveFile(buffer: Buffer, originalFilename: string, allowedExts: string[]): { storedFilename: string; ext: string } | null {
  const ext = path.extname(originalFilename).toLowerCase()
  if (!allowedExts.includes(ext)) return null
  if (!verifyMagicBytes(buffer, ext)) return null
  const storedFilename = `${uuidv4()}${ext}`
  fs.writeFileSync(path.join(GIFS_DIR, storedFilename), buffer)
  return { storedFilename, ext }
}

// GET /api/gifs — list gifs/stickers with optional filters
gifRoutes.get('/', authMiddleware, (c) => {
  const db = getDb()
  const type = c.req.query('type') || ''
  const category = c.req.query('category') || ''
  const pack = c.req.query('pack') || ''
  const search = c.req.query('search') || ''
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200)
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0

  let sql = 'SELECT * FROM gifs WHERE 1=1'
  const params: (string | number)[] = []

  if (type && (type === 'gif' || type === 'sticker')) {
    sql += ' AND type = ?'
    params.push(type)
  }

  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }

  if (pack) {
    sql += ' AND pack_name = ?'
    params.push(pack)
  }

  if (search) {
    sql += ' AND (display_name LIKE ? OR tags LIKE ?)'
    const like = `%${search}%`
    params.push(like, like)
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(sql).all(...params) as any[]
  return c.json({ gifs: rows.map(gifRowToResponse) })
})

// GET /api/gifs/categories — distinct categories in use
gifRoutes.get('/categories', authMiddleware, (c) => {
  const db = getDb()
  const type = c.req.query('type') || ''
  let sql = "SELECT DISTINCT category FROM gifs WHERE category != ''"
  const params: string[] = []

  if (type && (type === 'gif' || type === 'sticker')) {
    sql += ' AND type = ?'
    params.push(type)
  }

  sql += ' ORDER BY category'
  const rows = db.prepare(sql).all(...params) as { category: string }[]
  return c.json({ categories: rows.map(r => r.category) })
})

// GET /api/gifs/packs — distinct sticker pack names
gifRoutes.get('/packs', authMiddleware, (c) => {
  const db = getDb()
  const rows = db.prepare(
    "SELECT DISTINCT pack_name FROM gifs WHERE type = 'sticker' AND pack_name IS NOT NULL AND pack_name != '' ORDER BY pack_name"
  ).all() as { pack_name: string }[]
  return c.json({ packs: rows.map(r => r.pack_name) })
})

// POST /api/gifs/upload — upload a single GIF (admin only)
gifRoutes.post('/upload', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_GIF_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_GIF_SIZE} bytes` }, 413)
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  const displayName = (formData.get('display_name') as string) || path.basename(file.name, path.extname(file.name))
  const category = (formData.get('category') as string) || 'uncategorized'
  const tags = (formData.get('tags') as string) || ''

  if (file.size > MAX_GIF_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_GIF_SIZE} bytes` }, 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const result = saveFile(buffer, file.name, ALLOWED_GIF_EXTS)
  if (!result) return c.json({ error: 'Invalid file. Only .gif files are allowed for single GIF uploads.' }, 415)

  const id = uuidv4()
  const db = getDb()
  db.prepare(
    `INSERT INTO gifs (id, type, display_name, category, tags, pack_name, stored_filename, original_filename, file_size, uploaded_by)
     VALUES (?, 'gif', ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(id, displayName, category, tags, result.storedFilename, file.name, file.size, user.userId)

  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as any
  return c.json(gifRowToResponse(row), 201)
})

// POST /api/gifs/pack — upload a GIF pack as ZIP (admin only)
gifRoutes.post('/pack', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  if (!file.name.toLowerCase().endsWith('.zip')) {
    return c.json({ error: 'Only .zip files are accepted for pack uploads' }, 400)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return c.json({ error: 'Invalid ZIP file' }, 400)
  }

  const packJsonEntry = zip.getEntry('pack.json')
  let packConfig: { name?: string; category?: string; gifs?: { filename: string; display_name: string; tags?: string }[] } | null = null
  if (packJsonEntry) {
    try {
      packConfig = JSON.parse(packJsonEntry.getData().toString('utf-8'))
    } catch {
      return c.json({ error: 'pack.json is not valid JSON' }, 400)
    }
  }

  const category = packConfig?.category || 'uncategorized'
  const db = getDb()
  let imported = 0

  const gifEntries = packConfig?.gifs
    ? zip.getEntries().filter(e => packConfig!.gifs!.some(g => g.filename === e.entryName))
    : zip.getEntries().filter(e => e.entryName.toLowerCase().endsWith('.gif'))

  for (const entry of gifEntries) {
    if (entry.isDirectory) continue
    const name = path.basename(entry.entryName)
    const ext = path.extname(name).toLowerCase()
    if (!ALLOWED_GIF_EXTS.includes(ext)) continue

    const data = entry.getData()
    if (data.length > MAX_GIF_SIZE) continue
    if (!verifyMagicBytes(data, ext)) continue

    const storedFilename = `${uuidv4()}${ext}`
    fs.writeFileSync(path.join(GIFS_DIR, storedFilename), data)

    const configEntry = packConfig?.gifs?.find(g => g.filename === entry.entryName)
    const displayName = configEntry?.display_name || path.basename(name, ext)
    const tags = configEntry?.tags || ''

    const id = uuidv4()
    db.prepare(
      `INSERT INTO gifs (id, type, display_name, category, tags, pack_name, stored_filename, original_filename, file_size, uploaded_by)
       VALUES (?, 'gif', ?, ?, ?, NULL, ?, ?, ?, ?)`
    ).run(id, displayName, category, tags, storedFilename, name, data.length, user.userId)
    imported++
  }

  return c.json({ imported }, 201)
})

// POST /api/gifs/sticker-pack — upload a sticker pack as ZIP (admin only)
gifRoutes.post('/sticker-pack', authMiddleware, async (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  let packName = (formData.get('pack_name') as string) || ''

  if (!file.name.toLowerCase().endsWith('.zip')) {
    return c.json({ error: 'Only .zip files are accepted for sticker pack uploads' }, 400)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    return c.json({ error: 'Invalid ZIP file' }, 400)
  }

  const packJsonEntry = zip.getEntry('pack.json')
  let packConfig: { name?: string; author?: string; stickers?: { filename: string; display_name: string }[] } | null = null
  if (packJsonEntry) {
    try {
      packConfig = JSON.parse(packJsonEntry.getData().toString('utf-8'))
    } catch {
      return c.json({ error: 'pack.json is not valid JSON' }, 400)
    }
  }

  if (!packName) packName = packConfig?.name || ''
  if (!packName.trim()) return c.json({ error: 'pack_name is required for sticker packs' }, 400)

  const db = getDb()
  let imported = 0

  const stickerEntries = packConfig?.stickers
    ? zip.getEntries().filter(e => packConfig!.stickers!.some(s => s.filename === e.entryName))
    : zip.getEntries().filter(e => {
      const ext = path.extname(e.entryName).toLowerCase()
      return ALLOWED_STICKER_EXTS.includes(ext)
    })

  for (const entry of stickerEntries) {
    if (entry.isDirectory) continue
    const name = path.basename(entry.entryName)
    const ext = path.extname(name).toLowerCase()
    if (!ALLOWED_STICKER_EXTS.includes(ext)) continue

    const data = entry.getData()
    if (data.length > MAX_GIF_SIZE) continue
    if (!verifyMagicBytes(data, ext)) continue

    const storedFilename = `${uuidv4()}${ext}`
    fs.writeFileSync(path.join(GIFS_DIR, storedFilename), data)

    const configEntry = packConfig?.stickers?.find(s => s.filename === entry.entryName)
    const displayName = configEntry?.display_name || path.basename(name, ext)

    const id = uuidv4()
    db.prepare(
      `INSERT INTO gifs (id, type, display_name, category, tags, pack_name, stored_filename, original_filename, file_size, uploaded_by)
       VALUES (?, 'sticker', ?, '', '', ?, ?, ?, ?, ?)`
    ).run(id, displayName, packName.trim(), storedFilename, name, data.length, user.userId)
    imported++
  }

  return c.json({ imported }, 201)
})

// DELETE /api/gifs/pack/:packName — delete an entire sticker pack (admin only)
gifRoutes.delete('/pack/:packName', authMiddleware, (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const packName = c.req.param('packName') || ''
  if (!packName) return c.json({ error: 'Pack name is required' }, 400)

  const db = getDb()
  const rows = db.prepare("SELECT * FROM gifs WHERE type = 'sticker' AND pack_name = ?").all(packName) as any[]

  for (const row of rows) {
    const filePath = path.join(GIFS_DIR, row.stored_filename)
    try { fs.unlinkSync(filePath) } catch {}
  }

  db.prepare("DELETE FROM gifs WHERE type = 'sticker' AND pack_name = ?").run(packName)

  return c.json({ ok: true, deleted: rows.length })
})

// DELETE /api/gifs/:id — delete a single gif/sticker (admin only)
gifRoutes.delete('/:id', authMiddleware, (c) => {
  const user = getAuth(c)
  if (!isUserAdmin(user.userId)) return c.json({ error: 'Admin access required' }, 403)

  const id = c.req.param('id') || ''
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as any
  if (!row) return c.json({ error: 'Not found' }, 404)

  const filePath = path.join(GIFS_DIR, row.stored_filename)
  try { fs.unlinkSync(filePath) } catch {}

  db.prepare('DELETE FROM gifs WHERE id = ?').run(id)

  return c.json({ ok: true })
})

// GET /api/gifs/:id/file — serve the gif/sticker file
gifRoutes.get('/:id/file', (c) => {
  const id = c.req.param('id') || ''
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as any
  if (!row) return c.json({ error: 'Not found' }, 404)

  const filePath = path.join(GIFS_DIR, row.stored_filename)
  if (!fs.existsSync(filePath)) return c.json({ error: 'File not found' }, 404)

  const content = fs.readFileSync(filePath)
  const contentType = getContentType(row.stored_filename)

  return new Response(content, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
})

export default gifRoutes
