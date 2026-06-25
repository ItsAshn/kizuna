import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { useDragToDismiss } from '../../hooks/useDragToDismiss'
import './BottomSheet.css'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  /** Optional title shown next to the drag handle. */
  title?: string
  children: ReactNode
  className?: string
}

/**
 * Mobile bottom sheet: a backdrop + slide-up panel with a drag handle and
 * swipe-to-dismiss. Intended for non-Modal surfaces (pickers, action menus)
 * that need a native-feeling sheet on phones. Modals use ui/Modal which renders
 * as a sheet on mobile via the same useDragToDismiss hook.
 */
export default function BottomSheet({ open, onClose, title, children, className = '' }: BottomSheetProps) {
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

  return (
    <div
      className={`bottom-sheet-overlay${closing ? ' bottom-sheet-overlay--closing' : ''}`}
      onClick={handleClose}
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
        <div className="bottom-sheet__body">{children}</div>
      </div>
    </div>
  )
}
