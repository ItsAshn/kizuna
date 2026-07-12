import { useEffect, useState, useCallback, useMemo } from 'react'
import { Mic, Eye, Database, Download } from 'lucide-react'
import { useVoiceStore } from '../store/voiceStore'
import { useSettingsStore } from '../store/settingsStore'
import { useUpdaterActions } from '../hooks/useUpdater'
import { isTauri, isMobileTauri } from '../utils/platform'
import { clearCryptoState } from '../store/keyStore'
import Modal from './ui/Modal'
import SettingsLayout, { type SettingsNavGroup } from './ui/SettingsLayout'
import { SettingsActionRow } from './user-settings/rows'
import { VoiceSection } from './user-settings/VoiceSection'
import { PrivacySection } from './user-settings/PrivacySection'
import './UserSettingsModal.css'

interface Props {
  onClose: () => void
}

const SECTION_LABELS: Record<string, string> = {
  voice: 'voice',
  privacy: 'privacy',
  data: 'data',
  updates: 'updates',
}

export default function UserSettingsModal({ onClose }: Props) {
  const { setAudioInputDeviceId, setAudioOutputDeviceId, setPushToTalkKey } = useVoiceStore()
  const {
    updateState, updateProgress, updateVersion, updateError,
  } = useSettingsStore()
  const { checkForUpdates, installUpdate, getVersion } = useUpdaterActions()

  const [activeTab, setActiveTab] = useState('voice')
  const [appVersion, setAppVersion] = useState('0.1.0')
  const [isDev, setIsDev] = useState(true)
  const [listeningForKey, setListeningForKey] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)

  const navGroups = useMemo<SettingsNavGroup[]>(() => {
    const tauri = isTauri()
    return [
      {
        label: 'media',
        items: [{ key: 'voice', label: 'voice', icon: <Mic size={15} /> }],
      },
      {
        label: 'app',
        items: [
          ...(tauri ? [{ key: 'privacy', label: 'privacy', icon: <Eye size={15} /> }] : []),
          { key: 'data', label: 'data', icon: <Database size={15} /> },
          ...(tauri ? [{ key: 'updates', label: 'updates', icon: <Download size={15} /> }] : []),
        ],
      },
    ]
  }, [])

  const handleKeyCapture = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setPushToTalkKey(e.code)
    setListeningForKey(false)
  }, [setPushToTalkKey])

  // Push-to-talk key capture and Escape-close share one capture-phase listener:
  // capture must win over ui/Modal's own bubble-phase Escape handling while a
  // key is being recorded, so these can't be split into separate effects.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (listeningForKey) {
        handleKeyCapture(e)
        return
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [onClose, listeningForKey, handleKeyCapture])

  useEffect(() => {
    let cancelled = false
    getVersion().then(v => {
      if (!cancelled) {
        setAppVersion(v)
        setIsDev(false)
      }
    })
    return () => { cancelled = true }
  }, [getVersion])

  const handleResetAudio = useCallback(() => {
    setAudioInputDeviceId(null)
    setAudioOutputDeviceId(null)
  }, [setAudioInputDeviceId, setAudioOutputDeviceId])

  const handleResetDatabase = useCallback(() => {
    clearCryptoState()
    localStorage.removeItem('kizuna-voice-settings')
    localStorage.removeItem('kizuna-servers')
    window.location.reload()
  }, [])

  return (
    <Modal
      open
      onClose={onClose}
      title="// user settings"
      className="settings-modal"
      footer={(handleClose) => (
        <button onClick={handleClose} className="settings-modal__done-btn">done</button>
      )}
    >
      <SettingsLayout
        groups={navGroups}
        activeKey={activeTab}
        onChange={setActiveTab}
        activeLabel={SECTION_LABELS[activeTab]}
      >

      {activeTab === 'voice' && (
        <VoiceSection listeningForKey={listeningForKey} setListeningForKey={setListeningForKey} />
      )}

      {activeTab === 'privacy' && <PrivacySection />}

      {activeTab === 'data' && (
        <div className="settings-tab-content">
          <div className="settings-card">
            <p className="settings-card-title">local data</p>
            <SettingsActionRow
              label="reset audio devices"
              hint="clear saved microphone and speaker selection"
              buttonLabel="reset"
              onClick={handleResetAudio}
            />
            <SettingsActionRow
              label="reset database"
              hint="clear all local data including sessions and settings"
              buttonLabel="reset"
              onClick={resetConfirm ? handleResetDatabase : () => setResetConfirm(true)}
              danger
              dangerConfirm={resetConfirm}
              onCancel={() => setResetConfirm(false)}
            />
          </div>
        </div>
      )}

      {activeTab === 'updates' && isTauri() && (
        <div className="settings-tab-content">
          <div className="settings-card">
            <p className="settings-card-title">version</p>
            <div className="settings-version-row">
              <span className="settings-version-text">
                Kizuna v{appVersion}{isDev && <span className="settings-version-dev"> (dev)</span>}
              </span>
              <button
                onClick={() => checkForUpdates()}
                disabled={updateState === 'checking' || updateState === 'downloading'}
                className="settings-btn"
              >
                {updateState === 'checking'
                  ? 'checking...'
                  : updateState === 'downloading'
                    ? `${updateProgress}%`
                    : 'check for updates'}
              </button>
            </div>
            {updateState === 'ready' && (
              <div className="settings-version-row">
                <span className="settings-alert settings-alert--success">
                  {isMobileTauri()
                    ? `update ${updateVersion} available`
                    : `update ${updateVersion} ready — restart to apply`}
                </span>
                <button onClick={installUpdate} className="settings-btn">
                  {isMobileTauri() ? 'download' : 'restart now'}
                </button>
              </div>
            )}
            {updateState === 'error' && (
              <p className="settings-alert settings-alert--error">
                {updateError || 'update check failed'}
              </p>
            )}
          </div>
        </div>
      )}
      </SettingsLayout>
    </Modal>
  )
}
