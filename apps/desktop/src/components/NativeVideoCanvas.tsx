import { useEffect, useRef } from 'react'
import { attachNativeCanvas } from '../hooks/videoReceiver'

/**
 * Shows a natively decoded video stream (Linux, where the webview has no
 * WebRTC): frames arrive from Rust as JPEGs and are painted on this canvas.
 */
export default function NativeVideoCanvas({
  streamId,
  className,
}: {
  streamId: number
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    return attachNativeCanvas(canvas, streamId)
  }, [streamId])
  return <canvas ref={ref} className={className} />
}
