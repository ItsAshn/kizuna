import type { ReactNode } from 'react'
import BottomSheet from './BottomSheet'
import { useOverlay } from '../../lib/overlayStack'

/**
 * Shared shell for picker popups: a floating panel with outside-click and
 * Escape dismissal on desktop, a native bottom sheet on phones. `base`
 * prefixes the class names (`{base}__overlay`, `{base}`, `{base}-sheet`,
 * `{base}-sheet-overlay`) so each picker keeps its own CSS.
 */
export default function PickerSurface({
  base,
  isMobile,
  onClose,
  children,
}: {
  base: string
  isMobile: boolean
  onClose: () => void
  children: ReactNode
}) {
  // The mobile BottomSheet registers itself (and animates out); the desktop
  // popover registers here so Escape/back close only the topmost overlay.
  useOverlay(!isMobile, onClose)

  if (isMobile) {
    return (
      <BottomSheet
        open
        onClose={onClose}
        className={`${base}-sheet`}
        overlayClassName={`${base}-sheet-overlay`}
      >
        {children}
      </BottomSheet>
    )
  }
  return (
    <div
      className={`${base}__overlay`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={base} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
