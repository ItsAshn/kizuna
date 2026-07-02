import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDragToDismiss } from '../../hooks/useDragToDismiss'
import './BottomSheet.css'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Optional title shown next to the drag handle. */
  title?: string
  /** Pass a function to get the animated `close` callback (plays the
      slide-down before calling onClose). */
  children: ReactNode | ((close: () => void) => ReactNode)
  className?: string
  /** Extra class on the backdrop overlay (e.g. to raise z-index above
      the surface the sheet was opened from). */
  overlayClassName?: string
}

/**
 * Mobile bottom sheet: a backdrop + slide-up panel with a drag handle and
 * swipe-to-dismiss. The canonical presenter for pickers and action menus on
 * phones (ActionSheet, ReactionPicker, GifPicker, UserStatusPicker). Modals
 * use ui/Modal, which renders as a sheet on mobile via the same
 * useDragToDismiss hook.
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  children,
  className = '',
  overlayClassName = '',
}: BottomSheetProps) {
  const [closing, setClosing] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 200)
  }, [closing, onClose])

  const dragHandlers = useDragToDismiss(sheetRef, { onDismiss: handleClose })

  useEffect(() => {
    setClosing(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, handleClose])

  if (!open) return null

  return createPortal(
    <div
      className={`bottom-sheet-overlay ${overlayClassName}${closing ? ' bottom-sheet-overlay--closing' : ''}`}
      onClick={(e) => {
        // Sheets can be nested in components with their own click handling
        // (toggles, outside-click listeners) — don't leak the backdrop tap.
        e.stopPropagation()
        handleClose()
      }}
      role="presentation"
    >
      <div
        ref={sheetRef}
        className={`bottom-sheet ${className}${closing ? ' bottom-sheet--closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="bottom-sheet__handle"
          onTouchStart={dragHandlers.onTouchStart}
          onTouchMove={dragHandlers.onTouchMove}
          onTouchEnd={dragHandlers.onTouchEnd}
        >
          <span className="bottom-sheet__grip" />
          {title && <span className="bottom-sheet__title">{title}</span>}
        </div>
        <div className="bottom-sheet__body">
          {typeof children === 'function' ? children(handleClose) : children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
