import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useMobile } from '../../hooks/useMobile'
import SettingsNav, { type SettingsNavGroup } from './SettingsNav'
import './SettingsLayout.css'

export type { SettingsNavGroup, SettingsNavItem } from './SettingsNav'

interface SettingsLayoutProps {
  groups: SettingsNavGroup[]
  activeKey: string
  onChange: (key: string) => void
  /** Label of the active item, shown in the mobile detail header. */
  activeLabel?: string
  /** Optional content pinned above the nav rail (e.g. a scope switcher). */
  navHeader?: ReactNode
  children: ReactNode
}

// Two-pane settings shell: a vertical SettingsNav on the left and a scrolling
// content pane on the right. Lives inside a Modal body. On mobile it collapses
// to a list -> detail drilldown: the nav fills the view, tapping an item slides
// to its content with a back button.
export default function SettingsLayout({
  groups,
  activeKey,
  onChange,
  activeLabel,
  navHeader,
  children,
}: SettingsLayoutProps) {
  const isMobile = useMobile()
  const [entered, setEntered] = useState(false)

  const handleChange = (key: string) => {
    onChange(key)
    if (isMobile) setEntered(true)
  }

  if (isMobile) {
    return (
      <div className="settings-layout settings-layout--mobile">
        {entered ? (
          <div className="settings-layout__content">
            <button
              type="button"
              className="settings-layout__back"
              onClick={() => setEntered(false)}
            >
              <ChevronLeft size={14} />
              <span>{activeLabel ?? 'back'}</span>
            </button>
            {children}
          </div>
        ) : (
          <div className="settings-layout__rail">
            {navHeader && <div className="settings-layout__rail-header">{navHeader}</div>}
            <SettingsNav groups={groups} activeKey={activeKey} onChange={handleChange} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="settings-layout">
      {navHeader ? (
        <div className="settings-layout__rail">
          <div className="settings-layout__rail-header">{navHeader}</div>
          <SettingsNav groups={groups} activeKey={activeKey} onChange={handleChange} />
        </div>
      ) : (
        <SettingsNav groups={groups} activeKey={activeKey} onChange={handleChange} />
      )}
      <div className="settings-layout__content" role="tabpanel">
        {children}
      </div>
    </div>
  )
}
