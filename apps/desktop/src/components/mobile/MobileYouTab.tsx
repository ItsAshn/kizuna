import { Settings, Plus, Download, ChevronRight } from 'lucide-react'
import { useHaptics } from '../../hooks/useHaptics'
import type { User } from '@kizuna/shared'
import './MobileYouTab.css'

interface MobileYouTabProps {
  user: User
  onOpenSettings: () => void
  onOpenExport: () => void
  onOpenConnect: () => void
  appName?: string
  appDesc?: string
}

export default function MobileYouTab({
  user,
  onOpenSettings,
  onOpenExport,
  onOpenConnect,
  appName = 'Kizuna',
  appDesc = 'Self-hosted voice & chat',
}: MobileYouTabProps) {
  const haptics = useHaptics()

  return (
    <div className="mobile-tab mobile-you-tab">
      <div className="mobile-tab__header">
        <h1 className="mobile-tab__title">You</h1>
      </div>
      <div className="mobile-tab__body mobile-you-tab__body">
        <div className="mobile-you-profile">
          <div className="mobile-you-profile__avatar">
            {user.avatar ? (
              <img
                src={user.avatar}
                alt=""
                className="mobile-you-profile__avatar-img"
              />
            ) : (
              <span className="mobile-you-profile__avatar-text">
                {(user.display_name || user.username)?.[0]?.toUpperCase()}
              </span>
            )}
          </div>
          <p className="mobile-you-profile__name">
            {user.display_name || user.username}
          </p>
          <p className="mobile-you-profile__username">@{user.username}</p>
        </div>

        <div className="mobile-you-menu">
          <button
            className="mobile-you-menu__item"
            onClick={() => {
              haptics.tap()
              onOpenSettings()
            }}
          >
            <span className="mobile-you-menu__item-icon mobile-you-menu__item-icon--settings">
              <Settings size={18} />
            </span>
            <span className="mobile-you-menu__item-label">Settings</span>
            <ChevronRight size={16} className="mobile-you-menu__item-chevron" />
          </button>

          <button
            className="mobile-you-menu__item"
            onClick={() => {
              haptics.tap()
              onOpenConnect()
            }}
          >
            <span className="mobile-you-menu__item-icon mobile-you-menu__item-icon--connect">
              <Plus size={18} />
            </span>
            <span className="mobile-you-menu__item-label">Connect to Server</span>
            <ChevronRight size={16} className="mobile-you-menu__item-chevron" />
          </button>

          <button
            className="mobile-you-menu__item"
            onClick={() => {
              haptics.tap()
              onOpenExport()
            }}
          >
            <span className="mobile-you-menu__item-icon mobile-you-menu__item-icon--export">
              <Download size={18} />
            </span>
            <span className="mobile-you-menu__item-label">Export / Import</span>
            <ChevronRight size={16} className="mobile-you-menu__item-chevron" />
          </button>
        </div>

        <div className="mobile-you-about">
          <p className="mobile-you-about__name">{appName}</p>
          <p className="mobile-you-about__desc">{appDesc}</p>
        </div>
      </div>
    </div>
  )
}
