import ToggleSwitch from '../ui/ToggleSwitch'
import { useServerStore } from '../../store/serverStore'
import { useSettingsStore } from '../../store/settingsStore'
import {
} from '@kizuna/shared'


export function NotificationSettings() {
  const session = useServerStore((s) => s.activeSession)
  const settings = useSettingsStore((s) => s.notificationSettings)
  const setNotificationSettings = useSettingsStore((s) => s.setNotificationSettings)
  const notificationSoundEnabled = useSettingsStore((s) => s.notificationSoundEnabled)
  const setNotificationSoundEnabled = useSettingsStore((s) => s.setNotificationSoundEnabled)
  const serverId = session?.serverId || ''
  const current = settings[serverId] || { level: 'all' as const, suppressEveryone: false }

  return (
    <>
      <div className="server-menu__field">
        <label className="server-menu__label">server notification level</label>
        <select
          value={current.level}
          onChange={(e) => setNotificationSettings(serverId, { ...current, level: e.target.value as 'all' | 'mentions' | 'none' })}
          className="server-menu__select"
        >
          <option value="all">All messages</option>
          <option value="mentions">Only @mentions</option>
          <option value="none">Nothing</option>
        </select>
      </div>
      <div className="server-menu__toggle-row">
        <label className="server-menu__label" style={{ margin: 0 }}>suppress @everyone and @here</label>
        <ToggleSwitch
          checked={current.suppressEveryone}
          onChange={(checked) => setNotificationSettings(serverId, { ...current, suppressEveryone: checked })}
          ariaLabel="suppress @everyone and @here"
        />
      </div>
      <div className="server-menu__toggle-row">
        <label className="server-menu__label" style={{ margin: 0 }}>notification sounds</label>
        <ToggleSwitch
          checked={notificationSoundEnabled}
          onChange={setNotificationSoundEnabled}
          ariaLabel="notification sounds"
        />
      </div>
    </>
  )
}

