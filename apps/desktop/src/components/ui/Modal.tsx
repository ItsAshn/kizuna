import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
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

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => {
      onClose()
      previousFocus.current?.focus()
    }, 200)
  }, [closing, onClose])

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
        className={`modal ${className}${closing ? ' modal--closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal__header">
          <span className="modal__header-title" id={titleId}>{title}</span>
          <button onClick={handleClose} className="modal__close-btn" aria-label="Close">
            <X size={14} />
          </button>
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
