import { useEffect, useRef } from 'react'

const SWIPE_THRESHOLD = 60
const SWIPE_MAX_DURATION = 400
const SWIPE_MAX_VERTICAL_DRIFT = 80

export function useSwipeBack(ref: React.RefObject<HTMLElement | null>, onSwipeBack: () => void, enabled: boolean = true) {
  const touchStart = useRef<{ x: number; y: number; time: number } | null>(null)
  const isSwiping = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    function handleTouchStart(e: TouchEvent) {
      if (!enabled || e.touches.length !== 1) return
      const touch = e.touches[0]
      if (touch.clientX > 48) return
      touchStart.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
      isSwiping.current = false
    }

    function handleTouchMove(e: TouchEvent) {
      if (!touchStart.current || !enabled) return
      const touch = e.touches[0]
      const deltaX = touch.clientX - touchStart.current.x
      const deltaY = Math.abs(touch.clientY - touchStart.current.y)

      if (!isSwiping.current && deltaX > 10 && deltaX > deltaY * 1.5) {
        isSwiping.current = true
      }

      if (isSwiping.current) {
        e.preventDefault()
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      if (!touchStart.current || !enabled) return
      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStart.current.x
      const deltaY = Math.abs(touch.clientY - touchStart.current.y)
      const duration = Date.now() - touchStart.current.time

      const isValid =
        deltaX > SWIPE_THRESHOLD &&
        deltaY < SWIPE_MAX_VERTICAL_DRIFT &&
        duration < SWIPE_MAX_DURATION

      if (isValid) {
        onSwipeBack()
      }

      touchStart.current = null
      isSwiping.current = false
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: false })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd)

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
    }
  }, [enabled, onSwipeBack, ref])
}
