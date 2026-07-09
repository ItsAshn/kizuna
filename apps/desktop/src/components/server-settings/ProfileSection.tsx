import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { updateProfile, deleteAccount } from '@kizuna/shared'
import Modal from '../ui/Modal'
import Checkbox from '../ui/Checkbox'
import ToggleSwitch from '../ui/ToggleSwitch'
import { useServerStore } from '../../store/serverStore'
import { useSettingsStore } from '../../store/settingsStore'
import { handleApiErr, fileToDataUrl } from './common'

export function ProfileSection({ onClose }: { onClose: () => void }) {
  const { activeSession: session } = useServerStore()
  const serverUrl = session?.url
  const navigate = useNavigate()

  const [displayName, setDisplayName] = useState(session?.user?.display_name ?? '')
  const [avatarPreview, setAvatarPreview] = useState<string | null>(session?.user?.avatar ?? null)
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState<string | null>(null)
  const profileFileRef = useRef<HTMLInputElement>(null)
  const pendingAvatarFile = useRef<File | null>(null)
  const [bannerPreview, setBannerPreview] = useState<string | null>(session?.user?.banner ?? null)
  const [bannerChanged, setBannerChanged] = useState(false)
  const bannerFileRef = useRef<HTMLInputElement>(null)
  const pendingBannerFile = useRef<File | null>(null)

  const serverBackgroundEnabled = useSettingsStore(s => s.serverBackgroundEnabled)
  const customCssEnabled = useSettingsStore(s => s.customCssEnabled)

  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteAllData, setDeleteAllData] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const handleDeleteAccount = useCallback(async () => {
    if (!serverUrl || !deletePassword) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteAccount(serverUrl, deletePassword, deleteAllData)
      useServerStore.getState().setActiveSession(null)
      onClose()
      navigate('/')
    } catch (err: unknown) {
      const msg = handleApiErr(err)
      if (msg.includes('401') || msg.includes('Invalid password')) {
        setDeleteError('Incorrect password')
      } else {
        setDeleteError(msg)
      }
    } finally {
      setDeleting(false)
    }
  }, [serverUrl, deletePassword, deleteAllData, onClose, navigate])

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setProfileMsg(null)
    pendingAvatarFile.current = file
    const url = URL.createObjectURL(file)
    setAvatarPreview(url)
    setAvatarChanged(true)
    e.target.value = ''
  }

  const handleBannerFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setProfileMsg(null)
    pendingBannerFile.current = file
    const url = URL.createObjectURL(file)
    setBannerPreview(url)
    setBannerChanged(true)
    e.target.value = ''
  }

  const handleSaveProfile = async () => {
    if (!serverUrl || !session) return
    setProfileSaving(true)
    setProfileMsg(null)
    try {
      let avatarPayload: string | null | undefined = undefined
      if (avatarChanged) {
        if (avatarPreview === null) {
          avatarPayload = null
          pendingAvatarFile.current = null
        } else if (pendingAvatarFile.current) {
          avatarPayload = await fileToDataUrl(pendingAvatarFile.current)
        }
      }
      let bannerPayload: string | null | undefined = undefined
      if (bannerChanged) {
        if (bannerPreview === null) {
          bannerPayload = null
          pendingBannerFile.current = null
        } else if (pendingBannerFile.current) {
          bannerPayload = await fileToDataUrl(pendingBannerFile.current, 800)
        }
      }
      const updated = await updateProfile(serverUrl, displayName, avatarPayload, bannerPayload)
      useServerStore.getState().setActiveSession({ ...session, user: updated })
      useServerStore.getState().updateServerInfo(session.serverId, { name: updated.display_name })
      setAvatarChanged(false)
      pendingAvatarFile.current = null
      setBannerChanged(false)
      pendingBannerFile.current = null
      setProfileMsg('saved')
      setTimeout(() => setProfileMsg(null), 3000)
    } catch (err) {
      setProfileMsg(handleApiErr(err))
    }
    setProfileSaving(false)
  }

  return (
    <>
    <section className="server-menu__section">

        <div className="server-menu__profile-preview">
          <div className="server-menu__profile-banner" onClick={() => bannerFileRef.current?.click()} title="change banner">
            {bannerPreview ? (
              <img src={bannerPreview} alt="" className="server-menu__profile-banner-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            ) : (
              <div className="server-menu__profile-banner-empty" />
            )}
            <div className="server-menu__profile-banner-overlay">
              <span>{bannerPreview ? 'change banner' : 'add banner'}</span>
            </div>
          </div>

          <div className="server-menu__profile-avatar-wrap">
            <div className="server-menu__profile-avatar" onClick={() => profileFileRef.current?.click()} title="change avatar">
              <span className="server-menu__profile-avatar-letter">{(displayName || session?.user?.display_name || '?')[0]?.toUpperCase()}</span>
              {avatarPreview && (
                <img src={avatarPreview} alt="" className="server-menu__profile-avatar-img" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
              )}
              <div className="server-menu__profile-avatar-overlay">
                <span>+</span>
              </div>
            </div>
          </div>

          <div className="server-menu__profile-actions">
            <button onClick={() => profileFileRef.current?.click()} className="server-menu__profile-action">avatar</button>
            {avatarPreview && (
              <button onClick={() => { pendingAvatarFile.current = null; setAvatarPreview(null); setAvatarChanged(true) }} className="server-menu__profile-action server-menu__profile-action--remove">clear avatar</button>
            )}
            <button onClick={() => bannerFileRef.current?.click()} className="server-menu__profile-action">{bannerPreview ? 'banner' : 'set banner'}</button>
            {bannerPreview && (
              <button onClick={() => { pendingBannerFile.current = null; setBannerPreview(null); setBannerChanged(true) }} className="server-menu__profile-action server-menu__profile-action--remove">clear</button>
            )}
          </div>
        </div>

        <input ref={profileFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
        <input ref={bannerFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBannerFile} />

        <div className="server-menu__settings-group" style={{ marginTop: '16px' }}>
          <p className="server-menu__settings-group-title">identity</p>
          <div className="server-menu__field">
            <label className="server-menu__label">display name</label>
            <input className="server-menu__input" maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="display name" />
          </div>
        </div>

        <div className="server-menu__settings-group">
          <p className="server-menu__settings-group-title">display</p>
          <div className="server-menu__toggle-row" style={{ marginTop: 0 }}>
            <label className="server-menu__label" style={{ margin: 0 }}>show server background</label>
            <ToggleSwitch
              checked={serverBackgroundEnabled}
              onChange={(checked) => useSettingsStore.getState().setServerBackgroundEnabled(checked)}
              ariaLabel="show server background"
            />
          </div>
          <div className="server-menu__toggle-row">
            <label className="server-menu__label" style={{ margin: 0 }}>enable custom css</label>
            <ToggleSwitch
              checked={customCssEnabled}
              onChange={(checked) => useSettingsStore.getState().setCustomCssEnabled(checked)}
              ariaLabel="enable custom css"
            />
          </div>
        </div>

        <div className="server-menu__save-row">
          <button onClick={handleSaveProfile} disabled={profileSaving} className="server-menu__save-btn">
            {profileSaving ? '...' : 'save profile'}
          </button>
          {profileMsg && (
            <span className={`server-menu__save-msg ${profileMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
              {profileMsg}
            </span>
          )}
        </div>

        <div className="server-menu__settings-group" style={{ marginTop: '16px' }}>
          <p className="server-menu__settings-group-title">danger zone</p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <p className="server-menu__hint" style={{ margin: 0 }}>permanently remove your account from this server.</p>
            <button onClick={() => { setDeleteConfirm(true); setDeleteAllData(false); setDeletePassword(''); setDeleteError('') }} className="server-menu__btn server-menu__btn--danger">
              delete account
            </button>
          </div>
        </div>
      </section>

    <Modal
      open={deleteConfirm}
      onClose={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteAllData(false); setDeleteError('') }}
      title="// delete account"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            className="server-menu__confirm-cancel"
            onClick={() => { setDeleteConfirm(false); setDeletePassword(''); setDeleteAllData(false); setDeleteError('') }}
            disabled={deleting}
          >
                cancel
          </button>
          <button
            onClick={handleDeleteAccount}
            disabled={deleting || !deletePassword}
            className="server-menu__btn server-menu__btn--danger"
          >
            {deleting ? 'deleting...' : 'delete account'}
          </button>
        </div>
      }
    >
      <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '16px' }}>
        your account will be permanently removed. your public messages remain visible to others
        unless you choose to delete all data below.
      </p>
      <Checkbox
        checked={deleteAllData}
        onChange={setDeleteAllData}
                    label="also delete all my data"
      />
      <div style={{ marginTop: '16px' }}>
        <label className="server-menu__label" style={{ marginBottom: '6px' }}>enter your password to confirm</label>
        <input
          type="password"
          className="server-menu__input"
          placeholder="your password"
          value={deletePassword}
          onChange={(e) => setDeletePassword(e.target.value)}
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') handleDeleteAccount() }}
        />
      </div>
      {deleteError && (
        <span className="server-menu__save-msg server-menu__save-msg--err" style={{ display: 'block', marginTop: '8px' }}>{deleteError}</span>
      )}
    </Modal>
    </>
  )
}
