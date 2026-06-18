import { useState, useEffect } from 'react'
import { MOBILE_BREAKPOINT, TABLET_BREAKPOINT } from './breakpoints'

/** Subscribe to a media query and re-render when it changes. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [query])

  return matches
}

/** True below the phone cutoff (single-pane layout). */
export function useMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}

/** True in the tablet band: full multi-pane layout, but space-constrained. */
export function useTablet(): boolean {
  return useMediaQuery(
    `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`,
  )
}

export { useMediaQuery, MOBILE_BREAKPOINT, TABLET_BREAKPOINT }
