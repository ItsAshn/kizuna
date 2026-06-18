/**
 * Canonical responsive breakpoints — single source of truth shared between JS and CSS.
 *
 * CSS media queries can't read these values, so the same numbers are documented at the
 * top of `styles/global.css`. Keep the two in sync.
 *
 *   sm  480  — small phone / large phone boundary
 *   md  768  — phone ↔ tablet (the "mobile" cutoff)
 *   lg 1024  — tablet ↔ desktop
 *   xl 1280  — wide desktop
 */
export const BREAKPOINTS = {
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const

export type Breakpoint = keyof typeof BREAKPOINTS

/** The phone cutoff: below this width the layout collapses to a single pane. */
export const MOBILE_BREAKPOINT = BREAKPOINTS.md

/** The desktop cutoff: at or above this width the full multi-pane layout is shown. */
export const TABLET_BREAKPOINT = BREAKPOINTS.lg
