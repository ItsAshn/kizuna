import type {
  FileAttachment,
} from '../types'
import { client, normalizeUrl, tokenStore } from './core'

// ─── Attachments ──────────────────────────────────────────

export async function uploadAttachment(
  serverUrl: string,
  channelId: string,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<FileAttachment> {
  const formData = new FormData()
  formData.append('file', file)

  if (onProgress || signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'))
        return
      }
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${normalizeUrl(serverUrl)}/api/attachments/${channelId}`)
      xhr.withCredentials = true
      const norm = normalizeUrl(serverUrl)
      const token = tokenStore.get(norm)
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      signal?.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100))
          }
        }
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText)
            resolve(data.attachment)
          } catch {
            reject(new Error('Invalid response'))
          }
        } else {
          let message = 'Upload failed'
          try { const err = JSON.parse(xhr.responseText); message = err.error || message } catch { /* ignore */ }
          reject(new Error(message))
        }
      }
      xhr.onerror = () => reject(new Error('Upload failed'))
      xhr.send(formData)
    })
  }

  const res = await client(serverUrl).post(`/api/attachments/${channelId}`, formData)
  return res.data.attachment
}

export async function fetchAttachments(
  serverUrl: string,
  messageId: string,
): Promise<FileAttachment[]> {
  const res = await client(serverUrl).get(`/api/attachments/message/${messageId}`)
  return res.data.attachments ?? res.data
}

