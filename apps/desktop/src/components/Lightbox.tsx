import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import IconButton from './ui/IconButton'
import './Lightbox.css'

interface LightboxImage {
  url: string
  filename: string
}

interface LightboxProps {
  images: LightboxImage[]
  initialIndex: number
  onClose: () => void
}

export default function Lightbox({ images, initialIndex, onClose }: LightboxProps) {
  const [index, setIndex] = useState(initialIndex)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const translateStart = useRef({ x: 0, y: 0 })
  const pinchStartDist = useRef(0)
  const pinchStartScale = useRef(1)

  const current = images[index]
  if (!current) return null

  const handlePrev = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    setIndex((i) => (i - 1 + images.length) % images.length)
  }, [images.length])

  const handleNext = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setScale(1)
    setTranslate({ x: 0, y: 0 })
    setIndex((i) => (i + 1) % images.length)
  }, [images.length])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    setScale((s) => Math.min(5, Math.max(0.5, s - e.deltaY * 0.002)))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale <= 1) return
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    translateStart.current = { ...translate }
  }, [scale, translate])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setTranslate({ x: translateStart.current.x + dx, y: translateStart.current.y + dy })
  }, [isDragging])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      pinchStartDist.current = Math.sqrt(dx * dx + dy * dy)
      pinchStartScale.current = scale
      setIsDragging(false)
      return
    }
    if (e.touches.length === 1 && scale > 1) {
      setIsDragging(true)
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      translateStart.current = { ...translate }
    }
  }, [scale, translate])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (pinchStartDist.current > 0) {
        const ratio = dist / pinchStartDist.current
        setScale(Math.min(5, Math.max(0.5, pinchStartScale.current * ratio)))
      }
      return
    }
    if (!isDragging) return
    const dx = e.touches[0].clientX - dragStart.current.x
    const dy = e.touches[0].clientY - dragStart.current.y
    setTranslate({ x: translateStart.current.x + dx, y: translateStart.current.y + dy })
  }, [isDragging])

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false)
    pinchStartDist.current = 0
  }, [])

  const handleDownload = useCallback(() => {
    const a = document.createElement('a')
    a.href = current.url
    a.download = current.filename
    a.click()
  }, [current])

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') { setScale(1); setTranslate({ x: 0, y: 0 }); setIndex((i) => (i - 1 + images.length) % images.length) }
      if (e.key === 'ArrowRight') { setScale(1); setTranslate({ x: 0, y: 0 }); setIndex((i) => (i + 1) % images.length) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [images.length, onClose])

  return createPortal(
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox__header">
        <span className="lightbox__counter">{index + 1} / {images.length}</span>
        <div className="lightbox__header-actions">
          <IconButton variant="floating" icon={<Download size={18} />} label="Download" title="Download" onClick={handleDownload} />
          <IconButton variant="floating" icon={<X size={20} />} label="Close" title="Close" onClick={onClose} />
        </div>
      </div>

      {images.length > 1 && (
        <>
          <button className="lightbox__nav lightbox__nav--prev" onClick={handlePrev} aria-label="Previous">
            <ChevronLeft size={24} />
          </button>
          <button className="lightbox__nav lightbox__nav--next" onClick={handleNext} aria-label="Next">
            <ChevronRight size={24} />
          </button>
        </>
      )}

      <div
        className="lightbox__content"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={current.url}
          alt={current.filename}
          className="lightbox__image"
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
          draggable={false}
        />
      </div>
    </div>,
    document.body,
  )
}
