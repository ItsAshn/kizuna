import { useSettingsStore } from '../../store/settingsStore'
import { SettingsToggleRow } from './rows'

export function NotificationsSection() {
  const { runInBackground, setRunInBackground } = useSettingsStore()

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <p className="settings-card-title">background</p>
        <SettingsToggleRow
          label="run in background"
          hint="closing the window minimizes Kizuna to the tray instead of quitting, so you keep receiving notifications"
          checked={runInBackground}
          onChange={setRunInBackground}
        />
      </div>
    </div>
  )
}
