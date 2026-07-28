import { useCallback, useRef } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'

/* Long-press for rows rendered in a list.
 *
 * useLongPress() is per-element and so can't be called inside a map, and a
 * tracker built fresh in each render would lose its pending timer whenever the
 * list re-rendered mid-press. This keeps one tracker on the component and binds
 * the row id at touchstart instead.
 *
 * Exists because `onContextMenu` is mouse-only: channel and server actions were
 * completely unreachable on touch, and styles/mobile.css sets
 * `-webkit-touch-callout: none`, which removes the platform fallback too. */

interface UseLongPressItemsOptions {
  onLongPress: (id: string, pos: { x: number; y: number }) => void
  threshold?: number
  enabled?: boolean
}

const MOVE_SLOP_PX = 8

export function useLongPressItems({
  onLongPress,
  threshold = 500,
  enabled = true,
}: UseLongPressItemsOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    start.current = null
  }, [])

  const bind = useCallback(
    (id: string) => ({
      onTouchStart: (e: ReactTouchEvent) => {
        if (!enabled || e.touches.length !== 1) return
        fired.current = false
        const { clientX: x, clientY: y } = e.touches[0]
        start.current = { x, y }
        timer.current = setTimeout(() => {
          timer.current = null
          fired.current = true
          onLongPress(id, { x, y })
        }, threshold)
      },
      onTouchMove: (e: ReactTouchEvent) => {
        const s = start.current
        if (!s) return
        const t = e.touches[0]
        if (Math.abs(t.clientX - s.x) > MOVE_SLOP_PX || Math.abs(t.clientY - s.y) > MOVE_SLOP_PX) {
          cancel()
        }
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
    }),
    [enabled, threshold, onLongPress, cancel],
  )

  /* The browser still fires a click after a long press, which would activate
   * the row out from under the menu that just opened. Rows call this first and
   * bail if it returns true; reading it clears the flag, so it suppresses
   * exactly one click. */
  const consumedTap = useCallback(() => {
    if (!fired.current) return false
    fired.current = false
    return true
  }, [])

  return { bind, consumedTap }
}
