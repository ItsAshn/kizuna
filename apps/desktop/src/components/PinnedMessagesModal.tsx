import { Pin, Trash2 } from 'lucide-react'
import type { PinnedMessage } from '@kizuna/shared'
import Modal from './ui/Modal'
import './PinnedMessagesModal.css'

interface Props {
  pins: PinnedMessage[]
  open: boolean
  onClose: () => void
  onJump: (messageId: string) => void
  onUnpin: (messageId: string) => void
}

export default function PinnedMessagesModal({ pins, open, onClose, onJump, onUnpin }: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Pinned Messages (${pins.length})`}
      className="pins-modal"
    >
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
    </Modal>
  )
}
