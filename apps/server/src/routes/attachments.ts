import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../db'
import { authMiddleware, isUserAdmin } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
import { uploadLimiter } from '../middleware/rateLimiter'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const attachmentRoutes = new Hono()

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10485760', 10)

const ALLOWED_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.mp4', '.webm', '.mp3', '.ogg', '.wav',
  '.pdf', '.txt', '.json',
]

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
}

function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

const MAGIC_BYTES: Record<string, number[][]> = {
  '.jpg': [[0xFF, 0xD8, 0xFF]],
  '.jpeg': [[0xFF, 0xD8, 0xFF]],
  '.png': [[0x89, 0x50, 0x4E, 0x47]],
  '.gif': [[0x47, 0x49, 0x46, 0x38]],
  '.webp': [[0x52, 0x49, 0x46, 0x46]],
  '.mp4': [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]],
  '.mp3': [[0xFF, 0xFB], [0xFF, 0xF3], [0xFF, 0xF2], [0x49, 0x44, 0x33]],
  '.ogg': [[0x4F, 0x67, 0x67, 0x53]],
  '.wav': [[0x52, 0x49, 0x46, 0x46]],
  '.pdf': [[0x25, 0x50, 0x44, 0x46]],
}

function verifyMagicBytes(buffer: Buffer, expectedExtension: string): boolean {
  const signatures = MAGIC_BYTES[expectedExtension]
  if (!signatures) return true
  for (const sig of signatures) {
    if (sig.length > buffer.length) continue
    let match = true
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) { match = false; break }
    }
    if (match) return true
  }
  return false
}

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

// POST /attachments/:channelId — upload file via multipart/form-data
attachmentRoutes.post('/:channelId', uploadLimiter as never, authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')

  const contentLength = parseInt(c.req.header('content-length') || '0', 10)
  if (contentLength > MAX_FILE_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` }, 413)
  }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return c.json({ error: `File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}` }, 415)
  }

  if (file.size > MAX_FILE_SIZE) {
    return c.json({ error: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` }, 413)
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  if (!verifyMagicBytes(buffer, ext)) {
    return c.json({ error: 'File content does not match its extension' }, 415)
  }

  const storedFilename = `${uuidv4()}${ext}`
  const filepath = path.join(UPLOADS_DIR, storedFilename)

  fs.writeFileSync(filepath, buffer)

  const id = uuidv4()
  const db = getDb()
  db.prepare(
    'INSERT INTO attachments (id, message_id, filename, url, size, content_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, '', file.name, `/api/attachments/file/${storedFilename}`, buffer.length, getContentType(file.name))

  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as any
  return c.json({
    attachment: {
      id: attachment.id,
      message_id: attachment.message_id || null,
      filename: attachment.filename,
      url: attachment.url,
      size: attachment.size,
      content_type: attachment.content_type || getContentType(attachment.filename),
      created_at: attachment.created_at * 1000,
    },
  }, 201)
})

// GET /attachments/message/:messageId
attachmentRoutes.get('/message/:messageId', authMiddleware, (c) => {
  const messageId = c.req.param('messageId')
  const db = getDb()
  const attachments = db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(messageId) as any[]
  const result = attachments.map((a) => ({
    id: a.id,
    message_id: a.message_id,
    filename: a.filename,
    url: a.url,
    size: a.size,
    content_type: a.content_type || getContentType(a.filename),
    created_at: a.created_at * 1000,
  }))
  return c.json({ attachments: result })
})

// GET /attachments/file/:filename — serve an uploaded file (public, for <img>/<video>/<audio> tags)
attachmentRoutes.get('/file/:filename', (c) => {
  const filename = c.req.param('filename') || ''
  const sanitized = path.basename(filename)
  if (sanitized !== filename || filename.includes('..')) {
    return c.json({ error: 'Invalid filename' }, 400)
  }

  const ext = path.extname(sanitized).toLowerCase()
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return c.json({ error: 'File type not allowed' }, 403)
  }

  const filepath = path.join(UPLOADS_DIR, sanitized)
  if (!fs.existsSync(filepath)) {
    return c.json({ error: 'File not found' }, 404)
  }

  const contentType = getContentType(sanitized)
  const content = fs.readFileSync(filepath)
  return new Response(content, {
    status: 200,
    headers: { 'Content-Type': contentType },
  })
})

// DELETE /attachments/:id — delete an attachment
attachmentRoutes.delete('/:id', authMiddleware, (c) => {
  const user = getAuth(c)
  const db = getDb()
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(c.req.param('id')) as any
  if (!attachment) return c.json({ error: 'Attachment not found' }, 404)

  if (!attachment.message_id) {
    if (!isUserAdmin(user.userId)) {
      return c.json({ error: 'Cannot delete unattached files' }, 403)
    }
  } else {
    const message = db.prepare('SELECT author_id FROM messages WHERE id = ?').get(attachment.message_id) as { author_id: string } | undefined
    if (message && message.author_id !== user.userId) {
      return c.json({ error: 'Not authorized' }, 403)
    }
  }

  const filepath = path.join(UPLOADS_DIR, path.basename(attachment.url))
  try { fs.unlinkSync(filepath) } catch { /* file may not exist */ }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(c.req.param('id'))
  return c.json({ ok: true })
})

export default attachmentRoutes
