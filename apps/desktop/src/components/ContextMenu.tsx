import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './ContextMenu.css'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  shortcut?: string
}

export interface ContextMenuSection {
  items: ContextMenuItem[]
}

interface ContextMenuProps {
  x: number
  y: number
  sections: ContextMenuSection[]
  onClose: () => void
  title?: string
}

export default function ContextMenu({ x, y, sections, onClose, title }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width > window.innerWidth - 8) {
      left = window.innerWidth - rect.width - 8
    }
    if (top + rect.height > window.innerHeight - 8) {
      top = window.innerHeight - rect.height - 8
    }
    if (left < 8) left = 8
    if (top < 8) top = 8
    setAdjustedPos({ left, top })
  }, [x, y])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: adjustedPos?.left ?? x,
        top: adjustedPos?.top ?? y,
        opacity: adjustedPos ? 1 : 0,
      }}
    >
      {title && (
        <div className="context-menu__title" role="presentation">{title}</div>
      )}
      {sections.map((section, si) => (
        <div key={si} role="group">
          {si > 0 && <div className="context-menu__divider" role="separator" />}
          {section.items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}${item.disabled ? ' context-menu__item--disabled' : ''}`}
              onClick={() => {
                if (!item.disabled) {
                  item.onClick()
                  onClose()
                }
              }}
              disabled={item.disabled}
            >
              <span>{item.label}</span>
              {item.shortcut && <span className="context-menu__shortcut">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  )
}
