import path from 'node:path'
import sharp from 'sharp'

const WEBP_QUALITY = 80

const STATIC_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const GIF_EXT = '.gif'

export interface ProcessedImage {
  buffer: Uint8Array
  filename: string
  width: number
  height: number
}

export function shouldProcessImage(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase()
  return STATIC_IMAGE_EXTS.has(ext) || ext === GIF_EXT
}

export async function processImage(buffer: Buffer, originalFilename: string): Promise<ProcessedImage> {
  const ext = path.extname(originalFilename).toLowerCase()

  if (STATIC_IMAGE_EXTS.has(ext)) {
    const output = Buffer.from(await sharp(buffer)
      .webp({ quality: WEBP_QUALITY })
      .toBuffer())

    const info = await sharp(output).metadata()
    const baseName = path.basename(originalFilename, ext)
    return {
      buffer: output,
      filename: `${baseName}.webp`,
      width: info.width || 0,
      height: info.height || 0,
    }
  }

  if (ext === GIF_EXT) {
    const output = Buffer.from(await sharp(buffer, { animated: true })
      .gif({ colours: 256 })
      .toBuffer())

    const info = await sharp(output, { animated: true }).metadata()
    return {
      buffer: output,
      filename: originalFilename,
      width: info.width || 0,
      height: info.height || 0,
    }
  }

  const meta = await sharp(buffer).metadata()
  return { buffer, filename: originalFilename, width: meta.width || 0, height: meta.height || 0 }
}
