import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One stack for every dismissible overlay: modals, sheets, pickers, the
 * lightbox, context menus. Two consumers need to agree on which overlay is in
 * front:
 *
 * - Escape. Each overlay used to bind its own window keydown listener, so one
 *   keypress closed every open overlay at once (a nested modal and its parent,
 *   or a picker and the modal it sat in). A single listener now closes only
 *   the topmost entry.
 * - The Android back button (MobileShell), which must dismiss the overlay in
 *   front before it pops a navigation level.
 *
 * Overlays register while open via `useOverlay`; registration order is the
 * stacking order.
 */

interface OverlayEntry {
  id: number
  close: () => void
  /** False when the overlay handles Escape itself (or must not close on it). */
  escape: boolean
}

const stack: OverlayEntry[] = []
let nextId = 1

function register(entry: OverlayEntry): () => void {
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
  }
}

export function isTopOverlay(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1].id === id
}

export function hasOpenOverlay(): boolean {
  return stack.length > 0
}

/** Closes the frontmost overlay. Returns false when nothing was open. */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.close()
  return true
}

if (typeof window !== 'undefined') {
  // Bubble phase on purpose: a focused element's own Escape handling (an
  // autocomplete popup in a composer, an inline edit) runs first and can
  // claim the key with preventDefault. Registered at module load, so it runs
  // before window listeners that components add later and can stop them.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    const top = stack[stack.length - 1]
    if (!top || !top.escape) return
    e.preventDefault()
    e.stopImmediatePropagation()
    top.close()
  })
}

/**
 * Registers an overlay on the stack while `open` is true. `onClose` is read
 * through a ref, so callers can pass inline closures. Returns a function that
 * reports whether this overlay is currently the topmost one (for focus traps).
 */
export function useOverlay(
  open: boolean,
  onClose: () => void,
  options: { escape?: boolean } = {},
): () => boolean {
  const escape = options.escape ?? true
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [id] = useState(() => nextId++)

  useEffect(() => {
    if (!open) return
    return register({ id, close: () => closeRef.current(), escape })
  }, [open, id, escape])

  return useCallback(() => isTopOverlay(id), [id])
}
