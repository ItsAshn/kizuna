import { useRef, useCallback } from 'react'

interface UseLongPressOptions {
  onLongPress: () => void
  onTap?: () => void
  threshold?: number
  enabled?: boolean
}

export function useLongPress({
  onLongPress,
  onTap,
  threshold = 500,
  enabled = true,
}: UseLongPressOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const movedRef = useRef(false)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const tapFiredRef = useRef(false)

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || e.touches.length !== 1) return
      tapFiredRef.current = false
      movedRef.current = false
      startPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      timerRef.current = setTimeout(() => {
        onLongPress()
        tapFiredRef.current = true
      }, threshold)
    },
    [enabled, threshold, onLongPress],
  )

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPosRef.current || !enabled) return
      const dx = Math.abs(e.touches[0].clientX - startPosRef.current.x)
      const dy = Math.abs(e.touches[0].clientY - startPosRef.current.y)
      if (dx > 8 || dy > 8) {
        movedRef.current = true
        if (timerRef.current) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }
    },
    [enabled],
  )

  const onTouchEnd = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!movedRef.current && !tapFiredRef.current && onTap) {
      onTap()
    }
    startPosRef.current = null
  }, [onTap])

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  }
}
