import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import IconButton from './IconButton'
import { useMobile } from '../../hooks/useMobile'
import { useDragToDismiss } from '../../hooks/useDragToDismiss'
import { useOverlay } from '../../lib/overlayStack'
import './Modal.css'

type ModalFooter = ReactNode | ((handleClose: () => void) => ReactNode)

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ModalFooter
  className?: string
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className = '',
}: ModalProps) {
  const [closing, setClosing] = useState(false)
  const [blurred, setBlurred] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  // Titles are styled like code comments ("// settings"); screen readers
  // should hear just the name.
  const accessibleTitle = title.replace(/^\/\/\s*/, '')
  const isMobile = useMobile()

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      onClose()
      previousFocus.current?.focus()
    }, 200)
  }, [closing, onClose])

  const dragHandlers = useDragToDismiss(modalRef, {
    onDismiss: handleClose,
    enabled: isMobile,
  })

  // Escape and the Android back button go through the shared overlay stack,
  // so with modals nested only the topmost one closes.
  const isTop = useOverlay(open, handleClose)

  useEffect(() => {
    if (open) previousFocus.current = document.activeElement as HTMLElement
  }, [open])

  useEffect(() => {
    if (!open || !modalRef.current) return

    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    function trap(e: KeyboardEvent) {
      // A nested modal's DOM can sit inside this one, so its Tab presses bubble
      // here too; only the topmost modal owns the focus cycle.
      if (e.key !== 'Tab' || !isTop()) return
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }

    modalRef.current.addEventListener('keydown', trap)
    first?.focus()

    return () => modalRef.current?.removeEventListener('keydown', trap)
  }, [open, isTop])

  useEffect(() => {
    setClosing(false)
    if (!open) setBlurred(false)
  }, [open])

  if (!open) return null

  return (
    <div
      className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}${blurred ? ' modal-overlay--blurred' : ''}`}
      onClick={handleClose}
      onAnimationEnd={() => {
        if (!closing) setBlurred(true)
      }}
      role="presentation"
    >
      <div
        ref={modalRef}
        className={`modal ${className}${closing ? ' modal--closing' : ''}${isMobile ? ' modal--sheet' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={accessibleTitle}
      >
        {isMobile && (
          <div
            className="modal__drag-handle"
            onTouchStart={dragHandlers.onTouchStart}
            onTouchMove={dragHandlers.onTouchMove}
            onTouchEnd={dragHandlers.onTouchEnd}
            aria-hidden="true"
          >
            <span className="modal__drag-grip" />
          </div>
        )}
        <div
          className="modal__header"
          onTouchStart={isMobile ? dragHandlers.onTouchStart : undefined}
          onTouchMove={isMobile ? dragHandlers.onTouchMove : undefined}
          onTouchEnd={isMobile ? dragHandlers.onTouchEnd : undefined}
        >
          <span className="modal__header-title" aria-hidden="true">
            {title}
          </span>
          <IconButton onClick={handleClose} label="Close" size="sm" icon={<X size={14} />} />
        </div>
        <div className="modal__body">{children}</div>
        {footer && (
          <div className="modal__footer">
            {typeof footer === 'function' ? footer(handleClose) : footer}
          </div>
        )}
      </div>
    </div>
  )
}
