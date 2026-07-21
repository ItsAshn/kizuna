import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react'
import { Mic, Eye, Database, Download, Bell, Activity } from 'lucide-react'
import { useVoiceStore } from '../store/voiceStore'
import { isTauri, isMobileTauri } from '../utils/platform'
import { clearCryptoState } from '../store/keyStore'
import Modal from './ui/Modal'
import SettingsLayout, { type SettingsNavGroup } from './ui/SettingsLayout'
import { SettingsActionRow } from './user-settings/rows'
import { VoiceSection } from './user-settings/VoiceSection'
import { PrivacySection } from './user-settings/PrivacySection'
import { NotificationsSection } from './user-settings/NotificationsSection'
import { UpdatesSection } from './user-settings/UpdatesSection'
import { EnvironmentSection } from './user-settings/EnvironmentSection'
import './UserSettingsModal.css'

interface Props {
  onClose: () => void
}

const SECTION_LABELS: Record<string, string> = {
  voice: 'voice',
  privacy: 'privacy',
  notifications: 'notifications',
  data: 'data',
  environment: 'environment',
  updates: 'updates',
}

/**
 * The "You" settings body — the SettingsLayout + sections, without the Modal
 * chrome. Rendered directly by SettingsModal (unified settings hub) and by the
 * thin UserSettingsModal wrapper below for any standalone use.
 */
export function UserSettingsBody({ onClose, navHeader }: { onClose: () => void; navHeader?: ReactNode }) {
  const { setAudioInputDeviceId, setAudioOutputDeviceId, setPushToTalkKey } = useVoiceStore()

  const [activeTab, setActiveTab] = useState('voice')
  const [listeningForKey, setListeningForKey] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)

  const navGroups = useMemo<SettingsNavGroup[]>(() => {
    const tauri = isTauri()
    const desktopTauri = tauri && !isMobileTauri()
    return [
      {
        label: 'media',
        items: [{ key: 'voice', label: 'voice', icon: <Mic size={15} /> }],
      },
      {
        label: 'app',
        items: [
          ...(tauri ? [{ key: 'privacy', label: 'privacy', icon: <Eye size={15} /> }] : []),
          ...(desktopTauri ? [{ key: 'notifications', label: 'notifications', icon: <Bell size={15} /> }] : []),
          { key: 'data', label: 'data', icon: <Database size={15} /> },
          ...(desktopTauri ? [{ key: 'environment', label: 'environment', icon: <Activity size={15} /> }] : []),
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
      <SettingsLayout
        groups={navGroups}
        activeKey={activeTab}
        onChange={setActiveTab}
        activeLabel={SECTION_LABELS[activeTab]}
        navHeader={navHeader}
      >

      {activeTab === 'voice' && (
        <VoiceSection listeningForKey={listeningForKey} setListeningForKey={setListeningForKey} />
      )}

      {activeTab === 'privacy' && <PrivacySection />}

      {activeTab === 'notifications' && <NotificationsSection />}

      {activeTab === 'environment' && <EnvironmentSection />}

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

      {activeTab === 'updates' && isTauri() && <UpdatesSection />}
      </SettingsLayout>
  )
}

export default function UserSettingsModal({ onClose }: Props) {
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
      <UserSettingsBody onClose={onClose} />
    </Modal>
  )
}
