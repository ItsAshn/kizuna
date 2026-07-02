import { useEffect, useRef } from 'react'

const SWIPE_THRESHOLD = 60
const SWIPE_MAX_DURATION = 400
const SWIPE_MAX_VERTICAL_DRIFT = 80
const SWIPE_COMMIT_FRACTION = 0.4
const EDGE_ZONE = 48

export function useSwipeBack(ref: React.RefObject<HTMLElement | null>, onSwipeBack: () => void, enabled: boolean = true) {
  const touchStart = useRef<{ x: number; y: number; time: number } | null>(null)
  const isSwiping = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    function resetTransform(animated: boolean) {
      if (!el) return
      if (animated) {
        el.style.transition = 'transform 0.2s ease-out'
        el.style.transform = 'translateX(0)'
        window.setTimeout(() => {
          el.style.transition = ''
          el.style.transform = ''
        }, 200)
      } else {
        el.style.transition = ''
        el.style.transform = ''
      }
    }

    function handleTouchStart(e: TouchEvent) {
      if (!enabled || e.touches.length !== 1) return
      const touch = e.touches[0]
      if (touch.clientX > EDGE_ZONE) return
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
        // Track the finger so the gesture feels physical rather than
        // firing invisibly on release.
        el!.style.transition = 'none'
        el!.style.transform = `translateX(${Math.max(0, deltaX)}px)`
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      if (!touchStart.current || !enabled) return
      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStart.current.x
      const deltaY = Math.abs(touch.clientY - touchStart.current.y)
      const duration = Date.now() - touchStart.current.time

      // A quick flick past the threshold or a deliberate drag across a
      // large fraction of the view both count as "go back".
      const isFlick =
        deltaX > SWIPE_THRESHOLD &&
        deltaY < SWIPE_MAX_VERTICAL_DRIFT &&
        duration < SWIPE_MAX_DURATION
      const isCommittedDrag =
        isSwiping.current && deltaX > el!.offsetWidth * SWIPE_COMMIT_FRACTION

      if (isFlick || isCommittedDrag) {
        resetTransform(false)
        onSwipeBack()
      } else if (isSwiping.current) {
        resetTransform(true)
      }

      touchStart.current = null
      isSwiping.current = false
    }

    function handleTouchCancel() {
      if (isSwiping.current) resetTransform(true)
      touchStart.current = null
      isSwiping.current = false
    }

    el.addEventListener('touchstart', handleTouchStart, { passive: false })
    el.addEventListener('touchmove', handleTouchMove, { passive: false })
    el.addEventListener('touchend', handleTouchEnd)
    el.addEventListener('touchcancel', handleTouchCancel)

    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchCancel)
    }
  }, [enabled, onSwipeBack, ref])
}
