import { useRef, useCallback, useEffect, useState } from 'react'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { Monitor, X, GripHorizontal } from 'lucide-react'
import './ScreenShareOverlay.css'

interface ScreenShareOverlayProps {
  videoElRef: React.MutableRefObject<HTMLVideoElement | null>
  stopScreenshare: () => void
}

export default function ScreenShareOverlay({ videoElRef, stopScreenshare }: ScreenShareOverlayProps) {
  const { screenSharePeerId, screenShareUsername, isScreenSharing } = useCallStore()
  const { activeVoiceChannelId } = useVoiceStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)

  const isActive = !!(screenSharePeerId || isScreenSharing)

  useEffect(() => {
    if (isActive && !mounted) setMounted(true)
  }, [isActive, mounted])

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
      if (!target.closest('.screenshare-overlay__header')) return
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
      if (!target.closest('.screenshare-overlay__header')) return
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
  }, [isActive])

  useEffect(() => {
    const videoContainer = videoContainerRef.current
    if (!videoContainer || !videoElRef.current) return
    videoContainer.innerHTML = ''
    videoContainer.appendChild(videoElRef.current)
  }, [screenSharePeerId, videoElRef])

  if (!mounted && !isActive) return null
  if (!activeVoiceChannelId && !isScreenSharing) return null

  const sharerName = isScreenSharing ? 'You' : (screenShareUsername || 'Unknown')

  return (
    <div
      ref={containerRef}
      className="screenshare-overlay"
      style={!isActive ? { display: 'none' } : undefined}
    >
      <div className="screenshare-overlay__header">
        <span className="screenshare-overlay__title">
          <GripHorizontal className="screenshare-overlay__title-icon" />
          {sharerName}'s Screen
        </span>
        <div className="screenshare-overlay__actions">
          {isScreenSharing && (
            <button
              className="screenshare-overlay__btn screenshare-overlay__btn--close"
              onClick={stopScreenshare}
              title="Stop sharing"
            >
              <X size={16} />
            </button>
          )}
          {!isScreenSharing && (
            <button
              className="screenshare-overlay__btn screenshare-overlay__btn--close"
              onClick={() => {
                useCallStore.getState().clearScreenSharePeer()
              }}
              title="Close"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="screenshare-overlay__body" ref={videoContainerRef}>
        {!videoElRef.current && (
          <div className="screenshare-overlay__empty">
            <Monitor size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
            <div>Waiting for video...</div>
          </div>
        )}
      </div>
    </div>
  )
}
