/* JS mirror of the motion scale in styles/global.css.
 *
 * CSS custom properties are the canonical definition; these constants exist
 * because the Web Animations API driven transitions (nav stack, swipe-back,
 * pull-to-refresh) need numeric durations per frame and can't afford a
 * getComputedStyle() read. Keep the two in sync by hand — the same arrangement
 * hooks/breakpoints.ts already uses for the breakpoint scale.
 */

export const DUR = {
  tap: 40,
  fast: 120,
  base: 150,
  slow: 200,
  sheet: 280,
  nav: 320,
} as const

export const EASE = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  decel: 'cubic-bezier(0.2, 0.8, 0.4, 1)',
  emphasized: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Duration to actually animate for, collapsed to ~0 under reduced motion. */
export function duration(ms: number): number {
  return prefersReducedMotion() ? 1 : ms
}
