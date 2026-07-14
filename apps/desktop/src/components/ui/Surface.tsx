import { forwardRef } from 'react'
import type { HTMLAttributes, ElementType } from 'react'
import './Surface.css'

type SurfaceElevation = 0 | 1 | 2 | 3
type SurfaceRadius = 'md' | 'lg' | 'xl'
type SurfacePadding = 'none' | 'sm' | 'md'

interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  /** Shadow depth → --elev-*. Default 0 (flat). */
  elevation?: SurfaceElevation
  /** Corner radius. Default 'xl'. */
  radius?: SurfaceRadius
  /** Recessed well instead of a raised card. */
  inset?: boolean
  /** Internal padding. Default 'none'. */
  padding?: SurfacePadding
  /** Render as a different element (e.g. 'section', 'aside'). Default 'div'. */
  as?: ElementType
}

/**
 * The canonical panel/card surface. Centralizes the --modal-bg + --border-color
 * + radius + elevation recipe, so every framed region shares one source of truth.
 * The main chat layout is flush/edge-to-edge and does not use this — it's for
 * floating regions (modals, drawers, cards).
 */
const Surface = forwardRef<HTMLElement, SurfaceProps>(function Surface(
  { elevation = 0, radius = 'xl', inset, padding = 'none', as, className, children, ...rest },
  ref,
) {
  const Component = (as || 'div') as ElementType
  const classes = [
    'ui-surface',
    `ui-surface--elev-${elevation}`,
    `ui-surface--radius-${radius}`,
    `ui-surface--pad-${padding}`,
    inset && 'ui-surface--inset',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Component ref={ref} className={classes} {...rest}>
      {children}
    </Component>
  )
})

export default Surface
