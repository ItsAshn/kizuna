import { useState, useEffect, useCallback, type ReactNode } from 'react'
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

  const handleClose = useCallback(() => {
    if (closing) return
    setClosing(true)
    setTimeout(() => onClose(), 200)
  }, [closing, onClose])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [handleClose])

  useEffect(() => {
    setClosing(false)
  }, [open])

  if (!open) return null

  return (
    <div
      className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`}
      onClick={handleClose}
    >
      <div
        className={`modal ${className}${closing ? ' modal--closing' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <span className="modal__header-title">{title}</span>
          <button onClick={handleClose} className="modal__close-btn">[esc]</button>
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
