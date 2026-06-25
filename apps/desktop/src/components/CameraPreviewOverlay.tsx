import { useRef, useCallback, useEffect, useState } from 'react'
import { X, GripHorizontal } from 'lucide-react'
import IconButton from './ui/IconButton'
import './CameraPreviewOverlay.css'

interface CameraPreviewOverlayProps {
  cameraStreamRef: React.MutableRefObject<MediaStream | null>
  isCameraOn: boolean
  toggleCamera: (channelId: string) => void
  channelId: string | null
}

export default function CameraPreviewOverlay({ cameraStreamRef, isCameraOn, toggleCamera, channelId }: CameraPreviewOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (isCameraOn && !mounted) setMounted(true)
  }, [isCameraOn, mounted])

  useEffect(() => {
    const video = videoRef.current
    const stream = cameraStreamRef.current
    if (video && stream) {
      video.srcObject = stream
    }
    return () => {
      if (video) video.srcObject = null
    }
  }, [cameraStreamRef, isCameraOn])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let dragging = false
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.camera-overlay__header')) return
      dragging = true
      startX = e.clientX
      startY = e.clientY
      const rect = container.getBoundingClientRect()
      startLeft = rect.left
      startTop = rect.top
      container.style.right = 'auto'
      container.style.bottom = 'auto'
      container.style.left = `${startLeft}px`
      container.style.top = `${startTop}px`
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      container.style.left = `${startLeft + dx}px`
      container.style.top = `${startTop + dy}px`
    }

    const onMouseUp = () => {
      dragging = false
    }

    const onTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.camera-overlay__header')) return
      e.preventDefault()
      dragging = true
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      const rect = container.getBoundingClientRect()
      startLeft = rect.left
      startTop = rect.top
      container.style.right = 'auto'
      container.style.bottom = 'auto'
      container.style.left = `${startLeft}px`
      container.style.top = `${startTop}px`
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!dragging) return
      const dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      container.style.left = `${startLeft + dx}px`
      container.style.top = `${startTop + dy}px`
    }

    const onTouchEnd = () => {
      dragging = false
    }

    container.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    container.addEventListener('touchstart', onTouchStart, { passive: false })
    window.addEventListener('touchmove', onTouchMove)
    window.addEventListener('touchend', onTouchEnd)
    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      container.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

  const handleClose = useCallback(() => {
    if (channelId) toggleCamera(channelId)
  }, [channelId, toggleCamera])

  if (!mounted && !isCameraOn) return null
  if (!channelId) return null

  return (
    <div
      ref={containerRef}
      className="camera-overlay"
      style={!isCameraOn ? { display: 'none' } : undefined}
    >
      <div className="camera-overlay__header">
        <span className="camera-overlay__title">
          <GripHorizontal className="camera-overlay__title-icon" />
          Your Camera
        </span>
        <IconButton
          size="sm"
          variant="danger"
          icon={<X size={16} />}
          label="Turn off camera"
          title="Turn off camera"
          onClick={handleClose}
        />
      </div>
      <div className="camera-overlay__body">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="camera-overlay__video"
        />
      </div>
    </div>
  )
}
