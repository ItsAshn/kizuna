import type {
  GifInfo,
  TaggerStatus,
} from '../types'
import { client } from './core'

// ─── GIFs & Stickers ─────────────────────────────────────

export async function fetchGifs(
  serverUrl: string,
  params?: { type?: 'gif' | 'sticker'; category?: string; pack?: string; search?: string; limit?: number; offset?: number },
): Promise<GifInfo[]> {
  const res = await client(serverUrl).get('/api/gifs', { params })
  return res.data.gifs ?? res.data
}

export async function fetchGifCategories(
  serverUrl: string,
  type?: 'gif' | 'sticker',
): Promise<string[]> {
  const res = await client(serverUrl).get('/api/gifs/categories', { params: type ? { type } : {} })
  return res.data.categories ?? res.data
}

export async function fetchStickerPacks(
  serverUrl: string,
): Promise<string[]> {
  const res = await client(serverUrl).get('/api/gifs/packs')
  return res.data.packs ?? res.data
}

export async function uploadGif(
  serverUrl: string,
  file: File,
  displayName: string,
  category?: string,
  tags?: string,
): Promise<GifInfo> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('display_name', displayName)
  if (category) formData.append('category', category)
  if (tags) formData.append('tags', tags)

  const res = await client(serverUrl).post('/api/gifs/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function uploadGifPack(
  serverUrl: string,
  file: File,
): Promise<{ imported: number }> {
  const formData = new FormData()
  formData.append('file', file)

  const res = await client(serverUrl).post('/api/gifs/pack', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function uploadStickerPack(
  serverUrl: string,
  file: File,
  packName: string,
): Promise<{ imported: number }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('pack_name', packName)

  const res = await client(serverUrl).post('/api/gifs/sticker-pack', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function uploadSticker(
  serverUrl: string,
  file: File,
  packName: string,
  displayName?: string,
): Promise<GifInfo> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('pack_name', packName)
  if (displayName) formData.append('display_name', displayName)

  const res = await client(serverUrl).post('/api/gifs/sticker', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

export async function updateGif(
  serverUrl: string,
  gifId: string,
  data: { display_name?: string; category?: string; tags?: string; suggested_tags?: string },
): Promise<GifInfo> {
  const res = await client(serverUrl).patch(`/api/gifs/${gifId}`, data)
  return res.data
}

export async function deleteGif(
  serverUrl: string,
  gifId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/gifs/${gifId}`)
}

export async function generateGifTags(
  serverUrl: string,
  gifId: string,
): Promise<GifInfo> {
  const res = await client(serverUrl).post(`/api/gifs/${gifId}/generate-tags`)
  return res.data
}

export async function loadTagger(
  serverUrl: string,
): Promise<{ message: string }> {
  const res = await client(serverUrl).post('/api/gifs/load-tagger')
  return res.data
}

export async function unloadTagger(
  serverUrl: string,
): Promise<{ message: string }> {
  const res = await client(serverUrl).post('/api/gifs/unload-tagger')
  return res.data
}

export async function getTaggerStatus(
  serverUrl: string,
): Promise<TaggerStatus> {
  const res = await client(serverUrl).get('/api/gifs/tagger-status')
  return res.data
}

export async function deleteStickerPack(
  serverUrl: string,
  packName: string,
): Promise<{ ok: boolean; deleted: number }> {
  const res = await client(serverUrl).delete(`/api/gifs/pack/${encodeURIComponent(packName)}`)
  return res.data
}

