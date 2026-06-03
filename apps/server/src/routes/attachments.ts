import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../db'
import { authMiddleware } from '../middleware/auth'
import type { AuthUser } from '../middleware/auth'
function getAuth(c: any): AuthUser { return c.get('auth' as never) as AuthUser }

const attachmentRoutes = new Hono()

// POST /attachments/:channelId — upload file via multipart/form-data
attachmentRoutes.post('/:channelId', authMiddleware, async (c) => {
  const user = getAuth(c)
  const channelId = c.req.param('channelId')

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)

  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

  const ext = path.extname(file.name) || '.bin'
  const filename = `${uuidv4()}${ext}`
  const filepath = path.join(uploadsDir, filename)

  const buffer = Buffer.from(await file.arrayBuffer())
  fs.writeFileSync(filepath, buffer)

  const id = uuidv4()
  const db = getDb()
  db.prepare(
    'INSERT INTO attachments (id, message_id, filename, url, size) VALUES (?, ?, ?, ?, ?)'
  ).run(id, '', file.name, `/uploads/${filename}`, buffer.length)

  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as any
  return c.json({
    attachment: {
      id: attachment.id,
      message_id: attachment.message_id || null,
      filename: attachment.filename,
      url: attachment.url,
      size: attachment.size,
      content_type: file.type || undefined,
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
    content_type: a.content_type,
    created_at: a.created_at * 1000,
  }))
  return c.json({ attachments: result })
})

export default attachmentRoutes
