import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import IconButton from './IconButton'
import { useMobile } from '../../hooks/useMobile'
import { useDragToDismiss } from '../../hooks/useDragToDismiss'
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

export default function Modal({ open, onClose, title, children, footer, className = '' }: ModalProps) {
  const [closing, setClosing] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const titleId = `modal-title-${title.replace(/\s+/g, '-').toLowerCase()}`
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

  useEffect(() => {
    if (!open) return

    previousFocus.current = document.activeElement as HTMLElement

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        handleClose()
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, handleClose])

  useEffect(() => {
    if (!open || !modalRef.current) return

    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    function trap(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
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
  }, [open])

  useEffect(() => {
    setClosing(false)
  }, [open])

  if (!open) return null

  return (
    <div
      className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`}
      onClick={handleClose}
      role="presentation"
    >
      <div
        ref={modalRef}
        className={`modal ${className}${closing ? ' modal--closing' : ''}${isMobile ? ' modal--sheet' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
          <span className="modal__header-title" id={titleId}>{title}</span>
          <IconButton onClick={handleClose} label="Close" size="sm" icon={<X size={14} />} />
        </div>
        <div className="modal__body">
          {children}
        </div>
        {footer && (
          <div className="modal__footer">
            {typeof footer === 'function' ? footer(handleClose) : footer}
          </div>
        )}
      </div>
    </div>
  )
}
