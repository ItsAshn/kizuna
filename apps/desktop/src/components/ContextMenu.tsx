import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import '../styles/context-menu.css'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    let adjustedX = x
    let adjustedY = y
    if (rect.right > window.innerWidth) adjustedX = window.innerWidth - rect.width - 8
    if (rect.bottom > window.innerHeight) adjustedY = window.innerHeight - rect.height - 8
    if (adjustedX < 0) adjustedX = 8
    if (adjustedY < 0) adjustedY = 8
    ref.current.style.left = `${adjustedX}px`
    ref.current.style.top = `${adjustedY}px`
  }, [x, y])

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y, position: 'fixed' }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
          onClick={() => { item.onClick(); onClose() }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
