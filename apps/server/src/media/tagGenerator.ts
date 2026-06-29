import { pipeline, env } from '@xenova/transformers'
import sharp from 'sharp'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { TAG_CANDIDATES } from './tagCandidates'
import Database from 'better-sqlite3'

env.allowLocalModels = false

type TaggerFn = (path: string, candidates: string[]) => Promise<Array<{ label: string; score: number }>>

let taggerPromise: Promise<TaggerFn> | null = null
let modelLoaded = false
let _taggingEnabled = false

export function setTaggingEnabled(enabled: boolean): void {
  _taggingEnabled = enabled
}

export function isTaggingEnabled(): boolean {
  return _taggingEnabled
}

export async function loadTagger(): Promise<void> {
  if (modelLoaded) return

  if (!taggerPromise) {
    console.log('[tagGenerator] Loading CLIP ViT-B/32 model (~600MB download, ~1.2-1.5GB RAM)...')
    taggerPromise = pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32')
      .then((p) => {
        modelLoaded = true
        console.log('[tagGenerator] CLIP model loaded successfully')
        return p as TaggerFn
      })
      .catch((err: Error) => {
        console.error('[tagGenerator] Failed to load CLIP model:', err.message)
        taggerPromise = null
        throw err
      })
  }

  await taggerPromise
}

export function unloadTagger(): void {
  taggerPromise = null
  modelLoaded = false
  console.log('[tagGenerator] CLIP model unloaded')
}

export function getTaggerStatus(): { loaded: boolean; loading: boolean } {
  return {
    loaded: modelLoaded,
    loading: taggerPromise !== null && !modelLoaded,
  }
}

async function getTagger(): Promise<TaggerFn> {
  if (!taggerPromise) throw new Error('Tagging model is not loaded. Call POST /api/gifs/load-tagger first.')
  return taggerPromise
}

function formatTags(suggested: { tag: string; confidence: number }[]): string {
  return suggested.map(s => s.tag).join(', ')
}

export async function generateTags(
  imageBuffer: Buffer,
  options?: { topK?: number; threshold?: number },
): Promise<{ tag: string; confidence: number }[]> {
  const topK = options?.topK ?? 5
  const threshold = options?.threshold ?? 0.2

  const metadata = await sharp(imageBuffer).metadata()
  let tmpPath: string | null = null

  try {
    if (metadata.format === 'gif') {
      tmpPath = path.join(os.tmpdir(), `kizuna-tag-${uuidv4()}.png`)
      await sharp(imageBuffer, { animated: true, page: 0 })
        .png()
        .toFile(tmpPath)
    } else {
      tmpPath = path.join(os.tmpdir(), `kizuna-tag-${uuidv4()}.png`)
      await sharp(imageBuffer).png().toFile(tmpPath)
    }

    const tagger = await getTagger()
    const results = (await tagger(tmpPath, TAG_CANDIDATES)) as Array<{ label: string; score: number }>

    return results
      .filter(r => r.score >= threshold)
      .slice(0, topK)
      .map(r => ({
        tag: r.label,
        confidence: Math.round(r.score * 100) / 100,
      }))
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    }
  }
}

export async function generateAndStoreTags(
  db: Database.Database,
  gifId: string,
  imageBuffer: Buffer,
): Promise<void> {
  if (!isTaggingEnabled()) return
  if (!modelLoaded) {
    console.log('[tagGenerator] Skipping auto-tag: model not loaded')
    return
  }

  try {
    const suggested = await generateTags(imageBuffer)
    if (suggested.length > 0) {
      const tagsStr = formatTags(suggested)
      db.prepare('UPDATE gifs SET suggested_tags = ? WHERE id = ?').run(tagsStr, gifId)
    }
  } catch (err: unknown) {
    console.error('[tagGenerator] Auto-tagging failed:', err instanceof Error ? err.message : err)
  }
}

export { TAG_CANDIDATES }
