import BottomSheet from './BottomSheet'
import { useHaptics } from '../../hooks/useHaptics'
import './ActionSheet.css'

export interface ActionSheetItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

export interface ActionSheetSection {
  items: ActionSheetItem[]
}

interface ActionSheetProps {
  /** Optional context line shown next to the grab handle (e.g. the message author). */
  title?: string
  sections: ActionSheetSection[]
  onClose: () => void
}

/**
 * Native-style action sheet for touch: the mobile presentation of contextual
 * menus (long-press actions, overflow menus). Desktop keeps the anchored
 * ContextMenu; this is what it renders below the phone breakpoint.
 */
export default function ActionSheet({ title, sections, onClose }: ActionSheetProps) {
  const haptics = useHaptics()

  return (
    <BottomSheet open onClose={onClose} title={title} overlayClassName="action-sheet-overlay">
      {(close) => (
        <div className="action-sheet" role="menu">
          {sections.map((section, si) => (
            <div key={si} role="group">
              {si > 0 && <div className="action-sheet__divider" role="separator" />}
              {section.items.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  className={`action-sheet__item${item.danger ? ' action-sheet__item--danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return
                    haptics.tap()
                    item.onClick()
                    close()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </BottomSheet>
  )
}
