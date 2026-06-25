import { useEffect, useRef } from 'react'
import { X, Pin, Trash2 } from 'lucide-react'
import type { PinnedMessage } from '@kizuna/shared'
import IconButton from './ui/IconButton'
import './PinnedMessagesModal.css'

interface Props {
  pins: PinnedMessage[]
  open: boolean
  onClose: () => void
  onJump: (messageId: string) => void
  onUnpin: (messageId: string) => void
}

export default function PinnedMessagesModal({ pins, open, onClose, onJump, onUnpin }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  if (!open) return null

  return (
    <div className="pins-modal__overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="pins-modal" ref={contentRef}>
        <div className="pins-modal__header">
          <div className="pins-modal__header-left">
            <Pin className="icon-sm" />
            <h3 className="pins-modal__title">Pinned Messages</h3>
            <span className="pins-modal__count">{pins.length}</span>
          </div>
          <IconButton size="sm" icon={<X className="icon-sm" />} label="Close" onClick={onClose} />
        </div>
        <div className="pins-modal__list">
          {pins.length === 0 && (
            <div className="pins-modal__empty">
              <Pin className="pins-modal__empty-icon" />
              <p className="pins-modal__empty-text">No pinned messages in this channel</p>
            </div>
          )}
          {pins.map((pin) => (
            <div key={pin.id} className="pins-modal__item-row">
              <button
                className="pins-modal__item"
                onClick={() => { onJump(pin.messageId); onClose() }}
              >
                <div className="pins-modal__item-header">
                  <div className="pins-modal__item-author">
                    <div className="pins-modal__item-avatar">
                      {pin.authorAvatar ? (
                        <img src={pin.authorAvatar} alt={pin.authorUsername} className="pins-modal__item-avatar-img" />
                      ) : (
                        <span className="pins-modal__item-avatar-placeholder">
                          {(pin.authorDisplayName || pin.authorUsername || '?').charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className="pins-modal__item-name">{pin.authorDisplayName || pin.authorUsername}</span>
                  </div>
                  <span className="pins-modal__item-time">
                    {new Date(pin.pinnedAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="pins-modal__item-content">
                  {pin.content.length > 200 ? pin.content.slice(0, 200) + '...' : pin.content}
                </p>
              </button>
              <button
                className="pins-modal__item-unpin"
                onClick={(e) => { e.stopPropagation(); onUnpin(pin.messageId) }}
                aria-label="Unpin message"
                title="Unpin message"
              >
                <Trash2 className="icon-xs" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
