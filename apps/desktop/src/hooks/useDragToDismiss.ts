import { useCallback, useRef, type RefObject, type TouchEvent } from 'react'
import { useHaptics } from './useHaptics'

interface DragToDismissOptions {
  /** Called when the drag passes the dismiss threshold. */
  onDismiss: () => void
  /** Distance in px the sheet must be dragged down to dismiss. */
  threshold?: number
  /** When false the handlers are no-ops (e.g. on desktop). */
  enabled?: boolean
}

/**
 * Drag-to-dismiss for bottom sheets. Attach the returned handlers to a drag
 * handle / header element and pass a ref to the sheet panel that should follow
 * the finger. The panel transform is mutated directly to avoid re-rendering on
 * every touchmove; it is cleared on release (either dismissing or snapping back).
 */
export function useDragToDismiss(
  sheetRef: RefObject<HTMLElement | null>,
  { onDismiss, threshold = 110, enabled = true }: DragToDismissOptions,
) {
  const startY = useRef(0)
  const offset = useRef(0)
  const dragging = useRef(false)
  const haptics = useHaptics()

  const onTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled) return
    startY.current = e.touches[0].clientY
    offset.current = 0
    dragging.current = true
    const el = sheetRef.current
    if (el) el.style.transition = 'none'
  }, [enabled, sheetRef])

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (!dragging.current) return
    const dy = e.touches[0].clientY - startY.current
    // Only follow downward drags; ignore upward pull.
    offset.current = dy > 0 ? dy : 0
    const el = sheetRef.current
    if (el) el.style.transform = offset.current ? `translateY(${offset.current}px)` : ''
  }, [sheetRef])

  const onTouchEnd = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    const el = sheetRef.current
    if (el) el.style.transition = ''
    if (offset.current > threshold) {
      haptics.light()
      onDismiss()
    } else if (el) {
      el.style.transform = ''
    }
    offset.current = 0
  }, [sheetRef, threshold, onDismiss, haptics])

  return { onTouchStart, onTouchMove, onTouchEnd }
}
