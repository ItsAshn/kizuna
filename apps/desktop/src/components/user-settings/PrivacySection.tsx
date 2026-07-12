import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settingsStore'
import { useVoiceStore } from '../../store/voiceStore'
import { useServerStore } from '../../store/serverStore'
import { isTauri } from '../../utils/platform'
import Button from '../ui/Button'
import Input from '../ui/Input'
import { ActivityIcon } from '../../utils/activity'
import type { UserActivity } from '@kizuna/shared'
import { SettingsToggleRow } from './rows'

export function PrivacySection() {
  const {
    shareAppActivity, setShareAppActivity,
    customAppActivity, setCustomAppActivity,
    shareMediaActivity, setShareMediaActivity,
    customMediaActivity, setCustomMediaActivity,
  } = useSettingsStore()
  const userActivities = useVoiceStore((s) => s.userActivities)
  const session = useServerStore((s) => s.activeSession)

  const [customAppInput, setCustomAppInput] = useState('')
  const [customMediaInput, setCustomMediaInput] = useState('')
  const [runningWindows, setRunningWindows] = useState<string[]>([])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<{ title: string; process_name: string; display_name: string }[]>('list_windows')
        .then((windows) => {
          if (cancelled) return
          const names = windows
            .map((w) => w.display_name || w.title)
            .filter((t): t is string => !!t && t.trim().length > 0)
          setRunningWindows([...new Set(names)])
        })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [])

  // Renders the "currently sharing" preview + custom-activity controls shared by
  // the app and media sections. Defined as a plain render helper (not a nested
  // component) so the <Input> keeps focus across re-renders while typing.
  const renderActivitySharing = (opts: {
    kind: 'app' | 'media'
    customActivity: string | null
    setCustomActivity: (v: string | null) => void
    customInput: string
    setCustomInput: (v: string) => void
  }) => {
    const { kind, customActivity, setCustomActivity, customInput, setCustomInput } = opts
    const userId = session?.user.id
    const ownActivity = userId ? userActivities[userId] : undefined
    const matchTypes = kind === 'app' ? ['game', 'app'] : ['music', 'video']
    const current = ownActivity && matchTypes.includes(ownActivity.type) ? ownActivity : undefined
    const previewActivity: UserActivity | null = current
      ? current
      : customActivity
        ? { type: 'other', name: customActivity }
        : null

    const commit = (val: string) => setCustomActivity(val.trim() || null)

    return (
      <div className="settings-activity-card">
        <div className="settings-activity-current">
          <span className="settings-activity-current-label">currently sharing</span>
          {previewActivity ? (
            <div className="settings-activity-now">
              <span className={`settings-activity-now-icon${previewActivity.icon ? ' settings-activity-now-icon--img' : ''}`}>
                <ActivityIcon activity={previewActivity} size={16} className="settings-activity-now-img" />
              </span>
              <span className="settings-activity-now-name">{previewActivity.name}</span>
              {!current && <span className="settings-activity-now-tag">custom</span>}
            </div>
          ) : (
            <span className="settings-activity-empty">nothing detected</span>
          )}
        </div>

        <div className="settings-activity-custom">
          <Input
            className="settings-activity-input"
            placeholder="set a custom activity…"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(customInput) }}
          />
          <Button size="sm" onClick={() => commit(customInput)} disabled={!customInput.trim()}>set</Button>
          {customActivity && (
            <Button size="sm" variant="danger" onClick={() => { setCustomActivity(null); setCustomInput('') }}>clear</Button>
          )}
        </div>

        {runningWindows.length > 0 && (
          <div className="settings-activity-suggestions">
            <span className="settings-activity-suggestions-label">running apps</span>
            <div className="settings-activity-chips">
              {runningWindows.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`settings-activity-chip${customActivity === name ? ' settings-activity-chip--active' : ''}`}
                  onClick={() => { setCustomInput(name); setCustomActivity(name) }}
                  title={name}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <p className="settings-card-title">activity sharing</p>

        <SettingsToggleRow
          label="share my games &amp; apps"
          hint="show the game or application currently in focus on your desktop"
          checked={shareAppActivity}
          onChange={setShareAppActivity}
        />

        <SettingsToggleRow
          label="share my music &amp; media"
          hint="show the song or video you're currently playing (e.g. Spotify)"
          checked={shareMediaActivity}
          onChange={setShareMediaActivity}
        />

        {shareAppActivity && renderActivitySharing({
          kind: 'app',
          customActivity: customAppActivity,
          setCustomActivity: setCustomAppActivity,
          customInput: customAppInput,
          setCustomInput: setCustomAppInput,
        })}

        {shareMediaActivity && renderActivitySharing({
          kind: 'media',
          customActivity: customMediaActivity,
          setCustomActivity: setCustomMediaActivity,
          customInput: customMediaInput,
          setCustomInput: setCustomMediaInput,
        })}
      </div>
    </div>
  )
}
