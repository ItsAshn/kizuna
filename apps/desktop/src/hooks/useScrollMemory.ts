import { useCallback, useRef } from 'react'

/* Per-view scroll restoration for the mobile navigation stack.
 *
 * Views are remounted on every navigation (keyed), which resets scroll
 * position — native stacks never do that. Offsets are kept in a module map
 * (not component state) so they outlive the components; the returned
 * callback ref saves on unmount and restores on mount, before paint.
 *
 * Compose with other refs inline: ref={(el) => { otherRef(el); scrollRef(el) }} */

const offsets = new Map<string, number>()

export function useScrollMemory(key: string) {
  const elRef = useRef<HTMLElement | null>(null)
  const keyRef = useRef(key)
  keyRef.current = key

  return useCallback((el: HTMLElement | null) => {
    if (el) {
      elRef.current = el
      const saved = offsets.get(keyRef.current)
      if (saved) el.scrollTop = saved
    } else if (elRef.current) {
      offsets.set(keyRef.current, elRef.current.scrollTop)
      elRef.current = null
    }
  }, [])
}
