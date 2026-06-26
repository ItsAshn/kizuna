import { type ReactNode, type KeyboardEvent, useRef } from 'react'
import './SettingsLayout.css'

export interface SettingsNavItem {
  key: string
  label: string
  icon?: ReactNode
}

export interface SettingsNavGroup {
  label?: string
  items: SettingsNavItem[]
}

interface SettingsNavProps {
  groups: SettingsNavGroup[]
  activeKey: string
  onChange: (key: string) => void
}

// Vertical, grouped nav (the left rail of SettingsLayout). Standalone and
// reusable. Renders an optional label per group, then icon + label items with
// arrow-key navigation and ARIA tablist semantics.
export default function SettingsNav({ groups, activeKey, onChange }: SettingsNavProps) {
  const navRef = useRef<HTMLDivElement>(null)
  const flatKeys = groups.flatMap((g) => g.items.map((i) => i.key))

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const idx = flatKeys.indexOf(activeKey)
    if (idx === -1) return
    const next =
      e.key === 'ArrowDown'
        ? (idx + 1) % flatKeys.length
        : (idx - 1 + flatKeys.length) % flatKeys.length
    onChange(flatKeys[next])
    const buttons = navRef.current?.querySelectorAll<HTMLButtonElement>('.settings-nav__item')
    buttons?.[next]?.focus()
  }

  return (
    <div
      ref={navRef}
      className="settings-nav"
      role="tablist"
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
    >
      {groups.map((group, gi) => (
        <div className="settings-nav__group" key={group.label ?? gi}>
          {group.label && <div className="settings-nav__group-label">{group.label}</div>}
          {group.items.map((item) => {
            const active = item.key === activeKey
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={`settings-nav__item${active ? ' settings-nav__item--active' : ''}`}
                onClick={() => onChange(item.key)}
              >
                {item.icon && <span className="settings-nav__icon">{item.icon}</span>}
                <span className="settings-nav__label">{item.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
