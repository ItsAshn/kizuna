import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import AdmZip from 'adm-zip'
import { getDb } from '../db'
import { adminMiddleware, authMiddleware } from '../middleware/auth'
import { processImage, shouldProcessImage } from '../media/imageProcessor'
import { isTaggingEnabled, generateAndStoreTags, generateTags, loadTagger, unloadTagger, getTaggerStatus } from '../media/tagGenerator'
import { getAuth } from '../utils/auth'

const gifRoutes = new Hono()

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const GIFS_DIR = process.env.GIFS_DIR || path.join(UPLOADS_DIR, 'gifs')
const MAX_GIF_SIZE = parseInt(process.env.MAX_GIF_SIZE || '52428800', 10)
const MAX_PACK_SIZE = parseInt(process.env.MAX_PACK_SIZE || '15728640', 10) // 15 MB

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

function gifRowToResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    display_name: row.display_name,
    category: row.category,
    tags: row.tags,
    suggested_tags: row.suggested_tags || '',
    pack_name: row.pack_name || null,
    file_url: `/api/gifs/${row.id}/file`,
    file_size: row.file_size,
    width: row.width || null,
    height: row.height || null,
    created_at: row.created_at,
  }
}

function normalizeTags(tags: string): string {
  return [...new Set(tags.split(',').map(t => t.trim()).filter(Boolean))].join(', ')
}

async function saveFile(buffer: Buffer, originalFilename: string, allowedExts: string[]): Promise<{ storedFilename: string; ext: string; size: number } | null> {
  const ext = path.extname(originalFilename).toLowerCase()
  if (!allowedExts.includes(ext)) return null
  if (!verifyMagicBytes(buffer, ext)) return null

  if (shouldProcessImage(originalFilename)) {
    try {
      const processed = await processImage(buffer, originalFilename)
      const storedFilename = `${uuidv4()}${path.extname(processed.filename)}`
      fs.writeFileSync(path.join(GIFS_DIR, storedFilename), processed.buffer)

      if (processed.thumbBuffer) {
        const thumbFilename = `${storedFilename}.thumb.webp`
        fs.writeFileSync(path.join(GIFS_DIR, thumbFilename), processed.thumbBuffer)
      }

      return { storedFilename, ext: path.extname(processed.filename), size: processed.buffer.length }
    } catch (imgErr: unknown) {
      const message = imgErr instanceof Error ? imgErr.message : String(imgErr)
      console.error('[gifs] Image processing failed, storing original:', message)
    }
  }

  const storedFilename = `${uuidv4()}${ext}`
  fs.writeFileSync(path.join(GIFS_DIR, storedFilename), buffer)
  return { storedFilename, ext, size: buffer.length }
}

// Validate, store and index a single sticker image into a pack.
// Returns the new gif id, or null if the data is too large or not an allowed sticker.
async function storeSticker(
  db: ReturnType<typeof getDb>,
  opts: { data: Buffer; originalName: string; displayName: string; packName: string; uploadedBy: string }
): Promise<string | null> {
  const { data, originalName, displayName, packName, uploadedBy } = opts
  if (data.length > MAX_GIF_SIZE) return null

  const result = await saveFile(data, originalName, ALLOWED_STICKER_EXTS)
  if (!result) return null

  const id = uuidv4()
  db.prepare(
    `INSERT INTO gifs (id, type, display_name, category, tags, pack_name, stored_filename, original_filename, file_size, uploaded_by)
     VALUES (?, 'sticker', ?, '', '', ?, ?, ?, ?, ?)`
  ).run(id, displayName, packName, result.storedFilename, originalName, result.size, uploadedBy)

  if (isTaggingEnabled()) {
    generateAndStoreTags(db, id, data).catch(err =>
      console.error('[gifs] Sticker auto-tagging failed:', err.message))
  }

  return id
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

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
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
gifRoutes.post('/upload', authMiddleware, adminMiddleware, async (c) => {
  const user = getAuth(c)

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_GIF_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_GIF_SIZE} bytes` }, 413)
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  const displayName = ((formData.get('display_name') as string) || path.basename(file.name, path.extname(file.name))).trim()
  if (!displayName) return c.json({ error: 'Display name is required' }, 400)

  const category = (formData.get('category') as string) || 'uncategorized'
  const tags = normalizeTags((formData.get('tags') as string) || '')

  if (file.size > MAX_GIF_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_GIF_SIZE} bytes` }, 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const result = await saveFile(buffer, file.name, ALLOWED_GIF_EXTS)
  if (!result) return c.json({ error: 'Invalid file. Only .gif files are allowed for single GIF uploads.' }, 415)

  const id = uuidv4()
  const db = getDb()
  db.prepare(
    `INSERT INTO gifs (id, type, display_name, category, tags, pack_name, stored_filename, original_filename, file_size, uploaded_by)
     VALUES (?, 'gif', ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(id, displayName, category, tags, result.storedFilename, file.name, result.size, user.userId)

  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>

  if (isTaggingEnabled()) {
    generateAndStoreTags(db, id, buffer).catch(err =>
      console.error('[gifs] Auto-tagging failed:', err.message))
  }

  return c.json(gifRowToResponse(row), 201)
})

// POST /api/gifs/pack — upload a GIF pack as ZIP (admin only)
gifRoutes.post('/pack', authMiddleware, adminMiddleware, async (c) => {
  const user = getAuth(c)

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_PACK_SIZE) {
    return c.json({ error: `Pack too large. Maximum size is ${MAX_PACK_SIZE} bytes` }, 413)
  }

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

    if (shouldProcessImage(name)) {
      try {
        const processed = await processImage(data, name)
        const storedFilename = `${uuidv4()}${path.extname(processed.filename)}`
        fs.writeFileSync(path.join(GIFS_DIR, storedFilename), processed.buffer)

        if (processed.thumbBuffer) {
          const thumbFilename = `${storedFilename}.thumb.webp`
          fs.writeFileSync(path.join(GIFS_DIR, thumbFilename), processed.thumbBuffer)
        }

        const configEntry = packConfig?.gifs?.find(g => g.filename === entry.entryName)
        const displayName = configEntry?.display_name || path.basename(name, ext)
        const tags = configEntry?.tags || ''

        const id = uuidv4()
        db.prepare(
          `INSERT INTO gifs (id, type, display_name, category, tags, pack_name, stored_filename, original_filename, file_size, uploaded_by)
           VALUES (?, 'gif', ?, ?, ?, NULL, ?, ?, ?, ?)`
        ).run(id, displayName, category, tags, storedFilename, name, processed.buffer.length, user.userId)
        imported++

        if (isTaggingEnabled()) {
          generateAndStoreTags(db, id, processed.buffer as unknown as Buffer).catch(err =>
            console.error('[gifs] Pack auto-tagging failed:', err.message))
        }

        continue
      } catch (imgErr: unknown) {
        const message = imgErr instanceof Error ? imgErr.message : String(imgErr)
        console.error('[gifs] Pack GIF processing failed, storing original:', message)
      }
    }

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

    if (isTaggingEnabled()) {
      generateAndStoreTags(db, id, data).catch(err =>
        console.error('[gifs] Pack auto-tagging failed:', err.message))
    }
  }

  return c.json({ imported }, 201)
})

// POST /api/gifs/sticker-pack — upload a sticker pack as ZIP (admin only)
gifRoutes.post('/sticker-pack', authMiddleware, adminMiddleware, async (c) => {
  const user = getAuth(c)

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_PACK_SIZE) {
    return c.json({ error: `Pack too large. Maximum size is ${MAX_PACK_SIZE} bytes` }, 413)
  }

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
    const configEntry = packConfig?.stickers?.find(s => s.filename === entry.entryName)
    const displayName = configEntry?.display_name || path.basename(name, ext)

    const id = await storeSticker(db, {
      data,
      originalName: name,
      displayName,
      packName: packName.trim(),
      uploadedBy: user.userId,
    })
    if (id) imported++
  }

  return c.json({ imported }, 201)
})

// POST /api/gifs/sticker — upload a single sticker into an existing or new pack (admin only)
gifRoutes.post('/sticker', authMiddleware, adminMiddleware, async (c) => {
  const user = getAuth(c)

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_GIF_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_GIF_SIZE} bytes` }, 413)
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  const packName = ((formData.get('pack_name') as string) || '').trim()
  if (!packName) return c.json({ error: 'Pack name is required' }, 400)

  const displayName = ((formData.get('display_name') as string) || path.basename(file.name, path.extname(file.name))).trim()

  if (file.size > MAX_GIF_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${MAX_GIF_SIZE} bytes` }, 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const db = getDb()
  const id = await storeSticker(db, {
    data: buffer,
    originalName: file.name,
    displayName,
    packName,
    uploadedBy: user.userId,
  })
  if (!id) return c.json({ error: 'Invalid file. Only .gif, .png and .webp stickers are allowed.' }, 415)

  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  return c.json(gifRowToResponse(row), 201)
})

// POST /api/gifs/load-tagger — load the CLIP tagging model into memory (admin only)
gifRoutes.post('/load-tagger', authMiddleware, adminMiddleware, async (c) => {

  if (!isTaggingEnabled()) return c.json({ error: 'Auto-tagging is not enabled. Set AUTO_TAGGING_ENABLED=true in env.' }, 400)

  const status = getTaggerStatus()
  if (status.loaded) return c.json({ message: 'Model already loaded' })

  try {
    await loadTagger()
    return c.json({ message: 'Model loaded successfully' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[gifs] Failed to load tagger:', message)
    return c.json({ error: 'Failed to load tagging model: ' + message }, 500)
  }
})

// POST /api/gifs/unload-tagger — unload the CLIP tagging model from memory (admin only)
gifRoutes.post('/unload-tagger', authMiddleware, adminMiddleware, async (c) => {

  unloadTagger()
  return c.json({ message: 'Model unloaded' })
})

// GET /api/gifs/tagger-status — check if the tagging model is loaded
gifRoutes.get('/tagger-status', async (c) => {
  const enabled = isTaggingEnabled()
  if (!enabled) return c.json({ loaded: false, loading: false, enabled: false })

  const status = getTaggerStatus()
  return c.json({ ...status, enabled })
})

// POST /api/gifs/:id/generate-tags — manually trigger tag generation (admin only)
gifRoutes.post('/:id/generate-tags', authMiddleware, adminMiddleware, async (c) => {

  const id = c.req.param('id')
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  if (!row) return c.json({ error: 'Not found' }, 404)

  if (!isTaggingEnabled()) return c.json({ error: 'Auto-tagging is not enabled. Set AUTO_TAGGING_ENABLED=true in env.' }, 400)

  const taggerStatus = getTaggerStatus()
  if (!taggerStatus.loaded) return c.json({ error: 'Tagging model is not loaded. Call POST /api/gifs/load-tagger first.' }, 400)

  const filePath = path.join(GIFS_DIR, row.stored_filename as string)
  if (!fs.existsSync(filePath)) return c.json({ error: 'File not found on disk' }, 404)

  try {
    const fileBuffer = fs.readFileSync(filePath)
    const suggested = await generateTags(fileBuffer)
    const tagsStr = suggested.map(s => s.tag).join(', ')
    db.prepare('UPDATE gifs SET suggested_tags = ? WHERE id = ?').run(tagsStr, id)

    const updated = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
    return c.json(gifRowToResponse(updated))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[gifs] Tag generation failed:', message)
    return c.json({ error: 'Tag generation failed: ' + message }, 500)
  }
})

// POST /api/gifs/:id/confirm-tags — accept suggested tags (admin only)
gifRoutes.post('/:id/confirm-tags', authMiddleware, adminMiddleware, async (c) => {

  const id = c.req.param('id')
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  if (!row) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json()
  const accepted: string[] = Array.isArray(body.accepted) ? body.accepted : []

  if (accepted.length === 0) return c.json({ error: 'No tags provided in "accepted" array' }, 400)

  const existingTags = ((row.tags as string) || '').split(',').map((t: string) => t.trim()).filter(Boolean)
  const merged = [...new Set([...existingTags, ...accepted])].join(', ')
  db.prepare('UPDATE gifs SET tags = ?, suggested_tags = ? WHERE id = ?').run(merged, '', id)

  const updated = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  return c.json(gifRowToResponse(updated))
})

// PATCH /api/gifs/:id — update gif/sticker metadata (admin only)
gifRoutes.patch('/:id', authMiddleware, adminMiddleware, async (c) => {

  const id = c.req.param('id')
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const body = await c.req.json()
  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  if (!row) return c.json({ error: 'Not found' }, 404)

  const displayName = body.display_name !== undefined ? body.display_name.trim() : row.display_name
  if (!displayName) return c.json({ error: 'Display name cannot be empty' }, 400)

  const category = body.category !== undefined ? (body.category.trim() || 'uncategorized') : row.category
  const tags = body.tags !== undefined ? normalizeTags(body.tags) : row.tags
  const suggestedTags = body.suggested_tags !== undefined ? normalizeTags(body.suggested_tags) : row.suggested_tags

  db.prepare('UPDATE gifs SET display_name = ?, category = ?, tags = ?, suggested_tags = ? WHERE id = ?')
    .run(displayName, category, tags, suggestedTags, id)

  const updated = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  return c.json(gifRowToResponse(updated))
})

// DELETE /api/gifs/pack/:packName — delete an entire sticker pack (admin only)
gifRoutes.delete('/pack/:packName', authMiddleware, adminMiddleware, (c) => {

  const packName = c.req.param('packName') || ''
  if (!packName) return c.json({ error: 'Pack name is required' }, 400)

  const db = getDb()
  const rows = db.prepare("SELECT * FROM gifs WHERE type = 'sticker' AND pack_name = ?").all(packName) as Record<string, unknown>[]

  for (const row of rows) {
    const filePath = path.join(GIFS_DIR, row.stored_filename as string)
    try { fs.unlinkSync(filePath) } catch {}
  }

  db.prepare("DELETE FROM gifs WHERE type = 'sticker' AND pack_name = ?").run(packName)

  return c.json({ ok: true, deleted: rows.length })
})

// DELETE /api/gifs/:id — delete a single gif/sticker (admin only)
gifRoutes.delete('/:id', authMiddleware, adminMiddleware, (c) => {

  const id = c.req.param('id') || ''
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  if (!row) return c.json({ error: 'Not found' }, 404)

  const filePath = path.join(GIFS_DIR, row.stored_filename as string)
  try { fs.unlinkSync(filePath) } catch {}

  db.prepare('DELETE FROM gifs WHERE id = ?').run(id)

  return c.json({ ok: true })
})

// GET /api/gifs/:id/thumb — serve a static thumbnail (first frame) for animated stickers
gifRoutes.get('/:id/thumb', (c) => {
  const id = c.req.param('id') || ''
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  if (!row) return c.json({ error: 'Not found' }, 404)

  const thumbPath = path.join(GIFS_DIR, `${row.stored_filename}.thumb.webp`)
  if (fs.existsSync(thumbPath)) {
    const stat = fs.statSync(thumbPath)
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`
    const ifNoneMatch = c.req.header('if-none-match')
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } })
    }
    return new Response(fs.createReadStream(thumbPath), {
      status: 200,
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=86400, immutable',
        'ETag': etag,
      },
    })
  }

  return new Response(null, { status: 404 })
})

// GET /api/gifs/:id/file — serve the gif/sticker file
gifRoutes.get('/:id/file', (c) => {
  const id = c.req.param('id') || ''
  if (!id) return c.json({ error: 'ID is required' }, 400)

  const db = getDb()
  const row = db.prepare('SELECT * FROM gifs WHERE id = ?').get(id) as Record<string, unknown>
  if (!row) return c.json({ error: 'Not found' }, 404)

  const filePath = path.join(GIFS_DIR, row.stored_filename as string)
  if (!fs.existsSync(filePath)) return c.json({ error: 'File not found' }, 404)

  const stat = fs.statSync(filePath)
  const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }

  const contentType = getContentType(row.stored_filename as string)

  return new Response(fs.createReadStream(filePath), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
      'ETag': etag,
    },
  })
})

export default gifRoutes
