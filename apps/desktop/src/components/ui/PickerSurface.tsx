import { useEffect, type ReactNode } from 'react'
import BottomSheet from './BottomSheet'

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
  useEffect(() => {
    // The mobile BottomSheet handles Escape itself (with exit animation).
    if (isMobile) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, isMobile])

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
