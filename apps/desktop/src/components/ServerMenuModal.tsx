import { useState, useCallback, useMemo } from 'react'
import {
  User, Bell, SlidersHorizontal, Users, Link2, Shield, Code, Image as ImageIcon, Trash2,
} from 'lucide-react'
import Modal from './ui/Modal'
import SettingsLayout, { type SettingsNavGroup } from './ui/SettingsLayout'
import { useServerStore } from '../store/serverStore'
import './ServerMenuModal.css'
import { ProfileSection } from './server-settings/ProfileSection'
import { OverviewSection } from './server-settings/OverviewSection'
import { CssSection } from './server-settings/CssSection'
import { InvitesSection } from './server-settings/InvitesSection'
import { MembersSection } from './server-settings/MembersSection'
import { RolesSection } from './server-settings/RolesSection'
import { GifsSection } from './server-settings/GifsSection'
import { WebhooksSection } from './server-settings/WebhooksSection'
import { LogsSection } from './server-settings/LogsSection'
import { NotificationSettings } from './server-settings/NotificationSettings'

interface Props {
  onClose: () => void
  onBackgroundChanged?: () => void
}

type Section =
  | 'profile'
  | 'notifications'
  | 'overview'
  | 'members'
  | 'invites'
  | 'roles'
  | 'css'
  | 'gifs'
  | 'webhooks'
  | 'logs'

const SECTION_LABELS: Record<Section, string> = {
  profile: 'profile',
  notifications: 'notifications',
  overview: 'overview',
  members: 'members',
  invites: 'invites',
  roles: 'roles',
  css: 'custom css',
  gifs: 'gifs & stickers',
  webhooks: 'webhooks',
  logs: 'logs & data',
}

export default function ServerMenuModal({ onClose, onBackgroundChanged }: Props) {
  const { activeSession: session } = useServerStore()
  const serverUrl = session?.url
  const isAdmin = session?.user?.role === 'admin'

  const [section, setSection] = useState<Section>('profile')

  // Left-nav groups: the "user" group is always shown; the "admin" group only
  // appears for admins. Item keys map 1:1 to the `section` union.
  const navGroups = useMemo<SettingsNavGroup[]>(() => {
    const groups: SettingsNavGroup[] = [
      {
        label: 'user',
        items: [
          { key: 'profile', label: 'profile', icon: <User size={15} /> },
          { key: 'notifications', label: 'notifications', icon: <Bell size={15} /> },
        ],
      },
    ]
    if (isAdmin) {
      groups.push({
        label: 'admin',
        items: [
          { key: 'overview', label: 'overview', icon: <SlidersHorizontal size={15} /> },
          { key: 'members', label: 'members', icon: <Users size={15} /> },
          { key: 'invites', label: 'invites', icon: <Link2 size={15} /> },
          { key: 'roles', label: 'roles', icon: <Shield size={15} /> },
          { key: 'css', label: 'custom css', icon: <Code size={15} /> },
          { key: 'gifs', label: 'gifs & stickers', icon: <ImageIcon size={15} /> },
          { key: 'webhooks', label: 'webhooks', icon: <Link2 size={15} /> },
          { key: 'logs', label: 'logs & data', icon: <Trash2 size={15} /> },
        ],
      })
    }
    return groups
  }, [isAdmin])

  const handleSectionChange = useCallback((key: string) => {
    setSection(key as Section)
  }, [])

  return (
    <Modal
      open
      onClose={onClose}
      title="// server menu"
      className="server-menu"
      footer={(handleClose) => (
        <button onClick={handleClose} className="server-menu__done-btn">done</button>
      )}
    >
      <SettingsLayout
        groups={navGroups}
        activeKey={section}
        onChange={handleSectionChange}
        activeLabel={SECTION_LABELS[section]}
      >
        {section === 'profile' && <ProfileSection onClose={onClose} />}

        {section === 'notifications' && (
          <section className="server-menu__section">
            <div className="server-menu__settings-group">
              <p className="server-menu__settings-group-title">notifications</p>
              <NotificationSettings />
            </div>
          </section>
        )}

        {section === 'overview' && <OverviewSection serverUrl={serverUrl} onBackgroundChanged={onBackgroundChanged} />}

        {section === 'members' && <MembersSection serverUrl={serverUrl} />}

        {section === 'invites' && <InvitesSection serverUrl={serverUrl} />}

        {section === 'roles' && <RolesSection serverUrl={serverUrl} />}

        {section === 'css' && <CssSection serverUrl={serverUrl} onBackgroundChanged={onBackgroundChanged} />}

        {section === 'gifs' && <GifsSection serverUrl={serverUrl} />}

        {section === 'webhooks' && (
          <div className="server-menu__section">
            <WebhooksSection />
          </div>
        )}

        {section === 'logs' && (
          <div className="server-menu__section">
            <LogsSection />
          </div>
        )}
      </SettingsLayout>
    </Modal>
  )
}
