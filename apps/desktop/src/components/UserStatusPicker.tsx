import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useVoiceStore } from '../store/voiceStore'
import { useServerStore } from '../store/serverStore'
import type { UserStatus } from '@kizuna/shared'
import './UserStatusPicker.css'

interface Props {
  socketRef: React.MutableRefObject<any>
  children: React.ReactNode
}

const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'busy', label: 'Busy' },
]

export default function UserStatusPicker({ socketRef, children }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const userStatuses = useVoiceStore((s) => s.userStatuses)
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const wrapperRef = useRef<HTMLDivElement>(null)

  const userId = session?.user.id
  const currentStatus: UserStatus = userId ? (userStatuses[userId] || 'online') : 'online'

  const updateCoords = useCallback(() => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect()
      setCoords({ top: rect.bottom + 4, left: rect.left })
    }
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [])

  function handleToggle() {
    if (!open) updateCoords()
    setOpen(!open)
  }

  function handleSelect(status: UserStatus) {
    setOpen(false)
    if (socketRef.current) {
      socketRef.current.emit('user:status', { status })
    }
  }

  return (
    <div
      ref={wrapperRef}
      className={`status-picker status-picker--${currentStatus}`}
      onClick={handleToggle}
      title={currentStatus}
    >
      {children}
      {open && createPortal(
        <div className="status-picker__dropdown" style={{ top: coords.top, left: coords.left, position: 'fixed' }}>
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`status-picker__option${currentStatus === opt.value ? ' status-picker__option--active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleSelect(opt.value) }}
            >
              <span className={`status-picker__dot status-picker__dot--${opt.value}`} />
              {opt.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
