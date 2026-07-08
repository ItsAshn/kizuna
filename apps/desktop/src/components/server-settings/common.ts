import { useEffect, useRef } from 'react'

export function handleApiErr(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e?.response?.data?.error || e?.message || 'request failed'
}

// Tracks mount state so async handlers can skip setState after unmount.
export function useMountedRef() {
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  return mountedRef
}

export function fileToDataUrl(file: File, maxSize = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxSize || height > maxSize) {
          if (width > height) { height = Math.round((height / width) * maxSize); width = maxSize }
          else { width = Math.round((width / height) * maxSize); height = maxSize }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}
