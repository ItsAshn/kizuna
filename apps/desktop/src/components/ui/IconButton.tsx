import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './IconButton.css'

type IconButtonSize = 'sm' | 'md' | 'lg'
type IconButtonVariant = 'ghost' | 'solid' | 'danger' | 'floating'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon to render (e.g. a lucide-react element). */
  icon: ReactNode
  /** Accessible label, applied as aria-label (icon buttons have no visible text). */
  label: string
  size?: IconButtonSize
  variant?: IconButtonVariant
  /** Toggled/selected state — brand-colored. */
  active?: boolean
}

/**
 * Canonical icon-only button. Default `ghost` mirrors the original
 * .chat-area__header-search-btn. `danger` adds a red-on-hover affordance for
 * close/destructive actions; `floating` is a translucent surface for controls
 * sitting over media (lightbox, screen-share).
 */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', variant = 'ghost', active, className, ...rest },
  ref,
) {
  const classes = [
    'icon-btn',
    size !== 'md' && `icon-btn--${size}`,
    variant !== 'ghost' && `icon-btn--${variant}`,
    active && 'icon-btn--active',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={active || undefined}
      {...rest}
    >
      {icon}
    </button>
  )
})

export default IconButton
