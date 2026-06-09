import { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import type { UserStatus } from '@kizuna/shared'
import '../styles/status-picker.css'

interface Props {
  socketRef: React.MutableRefObject<any>
}

const STATUS_OPTIONS: { value: UserStatus; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'idle', label: 'Idle' },
  { value: 'busy', label: 'Busy' },
]

export default function UserStatusPicker({ socketRef }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const userStatuses = useChatStore((s) => s.userStatuses)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const userId = session?.user.id
  const currentStatus: UserStatus = userId ? (userStatuses[userId] || 'online') : 'online'

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleSelect(status: UserStatus) {
    setOpen(false)
    if (socketRef.current) {
      socketRef.current.emit('user:status', { status })
    }
  }

  return (
    <div className="status-picker" ref={ref}>
      <button
        className={`status-picker__trigger status-picker__trigger--${currentStatus}`}
        onClick={() => setOpen(!open)}
        title={currentStatus}
      />
      {open && (
        <div className="status-picker__dropdown">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`status-picker__option${currentStatus === opt.value ? ' status-picker__option--active' : ''}`}
              onClick={() => handleSelect(opt.value)}
            >
              <span className={`status-picker__dot status-picker__dot--${opt.value}`} />
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
