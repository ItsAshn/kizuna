import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../db'
import type { Context } from 'hono'
import {
  authMiddleware,
  canViewChannel,
  getUserPermissions,
  hasPermission,
  isUserAdmin,
} from '../middleware/auth'
import { processImage, shouldProcessImage } from '../media/imageProcessor'
import { getAuth } from '../utils/auth'
import { ALLOWED_ATTACHMENT_EXTENSIONS } from '@kizuna/shared/attachments'

const attachmentRoutes = new Hono()

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '10485760', 10)

// Shared with the client so its file picker offers exactly what this route will
// accept. Magic-byte validation below is keyed off the same list.
const ALLOWED_EXTENSIONS: readonly string[] = ALLOWED_ATTACHMENT_EXTENSIONS

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
  '.jpg': [[0xff, 0xd8, 0xff]],
  '.jpeg': [[0xff, 0xd8, 0xff]],
  '.png': [[0x89, 0x50, 0x4e, 0x47]],
  '.gif': [[0x47, 0x49, 0x46, 0x38]],
  '.webp': [[0x52, 0x49, 0x46, 0x46]],
  // WebM/Matroska: EBML header.
  '.webm': [[0x1a, 0x45, 0xdf, 0xa3]],
  '.mp3': [
    [0xff, 0xfb],
    [0xff, 0xf3],
    [0xff, 0xf2],
    [0x49, 0x44, 0x33],
  ],
  '.ogg': [[0x4f, 0x67, 0x67, 0x53]],
  '.wav': [[0x52, 0x49, 0x46, 0x46]],
  '.pdf': [[0x25, 0x50, 0x44, 0x46]],
}

// ISO-BMFF (MP4): the first box is `ftyp`, but its 4-byte size varies by
// encoder (0x18, 0x1c, 0x20, ...), so only bytes 4..8 are fixed.
function isIsoBmff(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.toString('latin1', 4, 8) === 'ftyp'
}

function verifyMagicBytes(buffer: Buffer, expectedExtension: string): boolean {
  if (expectedExtension === '.mp4') return isIsoBmff(buffer)
  const signatures = MAGIC_BYTES[expectedExtension]
  if (!signatures) return true
  for (const sig of signatures) {
    if (sig.length > buffer.length) continue
    let match = true
    for (let i = 0; i < sig.length; i++) {
      if (buffer[i] !== sig[i]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

// Multipart framing (boundaries, part headers) on top of the file itself. The
// exact per-file cap is still enforced on file.size after parsing.
const MULTIPART_OVERHEAD = 64 * 1024
const MAX_UPLOAD_BODY = MAX_FILE_SIZE + MULTIPART_OVERHEAD

// Unattached uploads older than this are swept (rows and files).
const UNATTACHED_TTL_SECONDS = 3600

// Who uploaded each not-yet-attached attachment, so the uploader can delete
// it before sending. The table has no uploader column; entries only need to
// outlive the unattached TTL, after which the sweep removes the row anyway.
const pendingUploaders = new Map<string, { userId: string; at: number }>()

function prunePendingUploaders(): void {
  const cutoff = Date.now() - UNATTACHED_TTL_SECONDS * 1000
  for (const [id, entry] of pendingUploaders) {
    if (entry.at < cutoff) pendingUploaders.delete(id)
  }
}

class BodyTooLargeError extends Error {}

/**
 * Parse multipart form data while counting bytes as they stream in, aborting
 * once more than `limit` arrive. Content-Length is checked up front, but this
 * keeps a lying header (or a transport that doesn't enforce it) from making
 * formData() buffer an unbounded body. Returns null if the cap was exceeded.
 */
async function readCappedFormData(c: Context, limit: number): Promise<FormData | null> {
  const raw = c.req.raw
  if (!raw.body) throw new Error('Missing request body')
  // Pull-based so nothing is read ahead of the parser, and the source is
  // cancelled (stopping the upload) as soon as the cap is crossed.
  const reader = raw.body.getReader()
  let seen = 0
  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      seen += value.byteLength
      if (seen > limit) {
        await reader.cancel().catch(() => {})
        controller.error(new BodyTooLargeError())
        return
      }
      controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const limited = new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    body: counted,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  try {
    return await limited.formData()
  } catch (err) {
    if (seen > limit || err instanceof BodyTooLargeError) return null
    throw err
  }
}

type AttachmentContainer =
  | { kind: 'channel'; channelId: string; authorId: string | null }
  | { kind: 'dm'; participants: [string, string]; authorId: string }
  | { kind: 'group-dm'; channelId: string; authorId: string }

/** Find which message table owns a message id and where that message lives. */
function resolveMessageContainer(messageId: string): AttachmentContainer | null {
  const db = getDb()
  const msg = db
    .prepare('SELECT channel_id, author_id FROM messages WHERE id = ?')
    .get(messageId) as { channel_id: string; author_id: string | null } | undefined
  if (msg) return { kind: 'channel', channelId: msg.channel_id, authorId: msg.author_id }

  const dm = db
    .prepare('SELECT from_id, to_id FROM direct_messages WHERE id = ?')
    .get(messageId) as { from_id: string; to_id: string } | undefined
  if (dm) return { kind: 'dm', participants: [dm.from_id, dm.to_id], authorId: dm.from_id }

  const gdm = db
    .prepare('SELECT channel_id, from_id FROM group_dm_messages WHERE id = ?')
    .get(messageId) as { channel_id: string; from_id: string } | undefined
  if (gdm) return { kind: 'group-dm', channelId: gdm.channel_id, authorId: gdm.from_id }

  return null
}

function canViewContainer(userId: string, container: AttachmentContainer): boolean {
  if (container.kind === 'dm') return container.participants.includes(userId)
  const db = getDb()
  if (container.kind === 'group-dm') {
    return !!db
      .prepare('SELECT 1 FROM group_dm_members WHERE channel_id = ? AND user_id = ?')
      .get(container.channelId, userId)
  }
  const exists = db.prepare('SELECT 1 FROM channels WHERE id = ?').get(container.channelId)
  return !!exists && canViewChannel(userId, container.channelId)
}

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
}

// POST /attachments/:channelId — upload file via multipart/form-data
attachmentRoutes.post('/:channelId', authMiddleware, async (c) => {
  const user = getAuth(c)

  const userPerms = getUserPermissions(user.userId)
  if (!userPerms || !hasPermission(userPerms, 'upload_attachments')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  try {
    // Refuse before buffering anything: no declared length (chunked) means we
    // can't bound the body up front, and formData() buffers it all in memory.
    const lengthHeader = c.req.header('content-length')
    if (!lengthHeader) return c.json({ error: 'Content-Length required' }, 411)
    const contentLength = Number(lengthHeader)
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      return c.json({ error: 'Invalid Content-Length' }, 400)
    }
    if (contentLength > MAX_UPLOAD_BODY) {
      return c.json(
        { error: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` },
        413,
      )
    }

    const formData = await readCappedFormData(c, MAX_UPLOAD_BODY)
    if (!formData) {
      return c.json(
        { error: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` },
        413,
      )
    }
    const fileEntry = formData.get('file')
    const file = fileEntry instanceof File ? fileEntry : null
    if (!file) return c.json({ error: 'No file provided' }, 400)

    const ext = path.extname(file.name).toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return c.json(
        { error: `File type not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}` },
        415,
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      return c.json(
        { error: `File too large. Maximum size is ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB` },
        413,
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    if (!verifyMagicBytes(buffer, ext)) {
      return c.json({ error: 'File content does not match its extension' }, 415)
    }

    let storedBuffer: Uint8Array = buffer
    let storedFilename = `${uuidv4()}${ext}`
    if (shouldProcessImage(file.name)) {
      try {
        const processed = await processImage(buffer, file.name)
        storedBuffer = processed.buffer
        storedFilename = `${uuidv4()}${path.extname(processed.filename)}`
      } catch (imgErr: unknown) {
        console.error(
          '[attachments] Image processing failed, storing original:',
          imgErr instanceof Error ? imgErr.message : imgErr,
        )
      }
    }

    const filepath = path.join(UPLOADS_DIR, storedFilename)
    fs.writeFileSync(filepath, storedBuffer)

    const id = uuidv4()
    const db = getDb()
    prunePendingUploaders()
    pendingUploaders.set(id, { userId: user.userId, at: Date.now() })
    db.prepare(
      'INSERT INTO attachments (id, message_id, filename, url, size, content_type) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      null,
      file.name,
      `/api/attachments/file/${storedFilename}`,
      storedBuffer.length,
      getContentType(storedFilename),
    )

    const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as {
      id: string
      message_id: string | null
      filename: string
      url: string
      size: number
      content_type: string | null
      created_at: number
    }
    return c.json(
      {
        attachment: {
          id: attachment.id,
          message_id: attachment.message_id || null,
          filename: attachment.filename,
          url: attachment.url,
          size: attachment.size,
          content_type: attachment.content_type || getContentType(attachment.filename),
          created_at: attachment.created_at * 1000,
        },
      },
      201,
    )
  } catch (err: unknown) {
    console.error('[attachments] Upload failed:', err instanceof Error ? err.message : err)
    return c.json({ error: 'Upload failed' }, 500)
  }
})

// GET /attachments/message/:messageId
attachmentRoutes.get('/message/:messageId', authMiddleware, (c) => {
  const user = getAuth(c)
  const messageId = c.req.param('messageId')!
  const container = resolveMessageContainer(messageId)
  if (!container || !canViewContainer(user.userId, container)) {
    return c.json({ error: 'Message not found' }, 404)
  }
  const db = getDb()
  const attachments = db
    .prepare('SELECT * FROM attachments WHERE message_id = ?')
    .all(messageId) as {
    id: string
    message_id: string | null
    filename: string
    url: string
    size: number
    content_type: string | null
    created_at: number
  }[]
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

  const stat = fs.statSync(filepath)
  const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`
  const ifNoneMatch = c.req.header('if-none-match')
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }

  const contentType = getContentType(sanitized)
  return new Response(fs.createReadStream(filepath), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
      ETag: etag,
    },
  })
})

// DELETE /attachments/:id — delete an attachment
attachmentRoutes.delete('/:id', authMiddleware, (c) => {
  const user = getAuth(c)
  const db = getDb()
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(c.req.param('id')) as
    | {
        id: string
        message_id: string | null
        filename: string
        url: string
        size: number
        content_type: string | null
        created_at: number
      }
    | undefined
  if (!attachment) return c.json({ error: 'Attachment not found' }, 404)

  const isAdmin = isUserAdmin(user.userId)
  if (!attachment.message_id) {
    // Unattached: only whoever uploaded it (tracked in memory until it is sent
    // or swept) or an admin.
    if (!isAdmin && pendingUploaders.get(attachment.id)?.userId !== user.userId) {
      return c.json({ error: 'Cannot delete unattached files' }, 403)
    }
  } else {
    // Attached: the message may be a channel message, a DM or a group DM.
    // Only its author may remove it; admins may moderate channel attachments.
    // If no owning message exists any more, only an admin may clean it up.
    const container = resolveMessageContainer(attachment.message_id)
    const isAuthor = !!container && container.authorId === user.userId
    const adminMayModerate = isAdmin && (!container || container.kind === 'channel')
    if (!isAuthor && !adminMayModerate) {
      return c.json({ error: 'Not authorized' }, 403)
    }
  }

  const filepath = path.join(UPLOADS_DIR, path.basename(attachment.url))
  try {
    fs.unlinkSync(filepath)
  } catch {
    /* file may not exist */
  }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id)
  pendingUploaders.delete(attachment.id)
  return c.json({ ok: true })
})

export function startOrphanCleanup(): void {
  const run = () => {
    try {
      const db = getDb()
      const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

      // Uploads that were never attached to a message within the TTL are
      // abandoned: drop their rows so the file sweep below removes the files.
      const cutoff = Math.floor(Date.now() / 1000) - UNATTACHED_TTL_SECONDS
      const staleRows = db
        .prepare('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?')
        .run(cutoff)
      prunePendingUploaders()

      const filenames = (db.prepare('SELECT url FROM attachments').all() as { url: string }[]).map(
        (r) => path.basename(r.url),
      )
      const knownFiles = new Set(filenames)

      let deletedCount = 0
      let freedBytes = 0
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(uploadsDir, { withFileTypes: true })
      } catch {}

      for (const entry of entries) {
        if (!entry.isFile() || knownFiles.has(entry.name)) continue
        const filepath = path.join(uploadsDir, entry.name)
        try {
          const stat = fs.statSync(filepath)
          // A file written moments ago may belong to an upload whose row
          // isn't committed yet; leave it for the next pass.
          if (Date.now() - stat.mtimeMs < 10 * 60_000) continue
          freedBytes += stat.size
          fs.unlinkSync(filepath)
          deletedCount++
        } catch {}
      }

      if (staleRows.changes > 0) {
        console.log(`[attachments] Removed ${staleRows.changes} unattached uploads older than 1h`)
      }
      if (deletedCount > 0) {
        console.log(
          `[attachments] Cleaned up ${deletedCount} orphan files (${(freedBytes / 1024 / 1024).toFixed(1)} MB)`,
        )
      }
    } catch (err: unknown) {
      console.error('[attachments] Orphan cleanup error:', err instanceof Error ? err.message : err)
    }
  }

  run()
  // Hourly so unattached uploads don't outlive their TTL by much.
  setInterval(run, 3600_000).unref()
}

export default attachmentRoutes
