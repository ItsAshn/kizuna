import { useRef, useEffect, useState } from 'react'
import { useVoiceStore } from '../store/voiceStore'
import { useCallStore } from '../store/callStore'
import { Monitor, X, GripHorizontal } from 'lucide-react'
import IconButton from './ui/IconButton'
import './ScreenShareOverlay.css'

interface ScreenShareOverlayProps {
  videoElRef: React.MutableRefObject<HTMLVideoElement | null>
  stopScreenshare: () => void
}

export default function ScreenShareOverlay({
  videoElRef,
  stopScreenshare,
}: ScreenShareOverlayProps) {
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

  // The shared <video> is adopted imperatively into a container React keeps
  // empty — it used to be appended into a node React was also rendering a
  // placeholder into, so clearing it tore out an element React still believed
  // it owned. Attachment is tracked in state because a ref read during render
  // never re-renders when it changes: the placeholder could outlive the video
  // arriving, or vanish without it.
  const [videoAttached, setVideoAttached] = useState(false)
  useEffect(() => {
    const videoContainer = videoContainerRef.current
    const el = videoElRef.current
    if (!videoContainer || !el) {
      setVideoAttached(false)
      return
    }
    videoContainer.replaceChildren(el)
    setVideoAttached(true)
    return () => {
      videoContainer.replaceChildren()
      setVideoAttached(false)
    }
  }, [screenSharePeerId, isScreenSharing, videoElRef])

  if (!mounted && !isActive) return null
  if (!activeVoiceChannelId && !isScreenSharing) return null

  const sharerName = isScreenSharing ? 'You' : screenShareUsername || 'Unknown'

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
            <IconButton
              size="sm"
              variant="danger"
              icon={<X size={16} />}
              label="Stop sharing"
              title="Stop sharing"
              onClick={stopScreenshare}
            />
          )}
          {!isScreenSharing && (
            <IconButton
              size="sm"
              variant="danger"
              icon={<X size={16} />}
              label="Close"
              title="Close"
              onClick={() => {
                useCallStore.getState().clearScreenSharePeer()
              }}
            />
          )}
        </div>
      </div>
      <div className="screenshare-overlay__body">
        <div className="screenshare-overlay__video" ref={videoContainerRef} />
        {!videoAttached && (
          <div className="screenshare-overlay__empty">
            <Monitor size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
            <div>Waiting for video...</div>
          </div>
        )}
      </div>
    </div>
  )
}
