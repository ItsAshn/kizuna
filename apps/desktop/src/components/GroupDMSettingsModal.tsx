import { useState, useRef, useEffect } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { updateGroupDM } from '@kizuna/shared'
import type { GroupDMChannelData } from '@kizuna/shared'
import { Camera, Users, X } from 'lucide-react'
import Modal from './ui/Modal'
import './GroupDMSettingsModal.css'

interface Props {
  groupDM: GroupDMChannelData
  onClose: () => void
}

function fileToDataUrl(file: File, maxSize = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxSize || height > maxSize) {
          if (width > height) { height = Math.round((height / width) * maxSize); width = maxSize }
          else { width = Math.round((width / height) * maxSize); height = maxSize }
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => reject(new Error('failed to load image'))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

export default function GroupDMSettingsModal({ groupDM, onClose }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const members = useChatStore((s) => s.members)
  const setGroupDMChannels = useChatStore((s) => s.setGroupDMChannels)
  const groupDMChannels = useChatStore((s) => s.groupDMChannels)

  const isOwner = session?.user.id === groupDM.owner_id

  const [name, setName] = useState(groupDM.name)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(groupDM.avatar ?? null)
  const [avatarChanged, setAvatarChanged] = useState(false)
  const [removingAvatar, setRemovingAvatar] = useState(false)
  const pendingAvatarFile = useRef<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      if (avatarPreview && avatarPreview.startsWith('blob:')) {
        URL.revokeObjectURL(avatarPreview)
      }
    }
  }, [])

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setMsg(null)
    pendingAvatarFile.current = file
    const url = URL.createObjectURL(file)
    if (avatarPreview && avatarPreview.startsWith('blob:')) URL.revokeObjectURL(avatarPreview)
    setAvatarPreview(url)
    setAvatarChanged(true)
    setRemovingAvatar(false)
    e.target.value = ''
  }

  const handleRemoveAvatar = () => {
    if (avatarPreview && avatarPreview.startsWith('blob:')) URL.revokeObjectURL(avatarPreview)
    pendingAvatarFile.current = null
    setAvatarPreview(null)
    setAvatarChanged(true)
    setRemovingAvatar(true)
  }

  const handleSave = async () => {
    if (!session) return
    setSaving(true)
    setMsg(null)
    try {
      let avatarPayload: string | null | undefined = undefined
      if (avatarChanged) {
        if (removingAvatar) {
          avatarPayload = null
        } else if (pendingAvatarFile.current) {
          avatarPayload = await fileToDataUrl(pendingAvatarFile.current)
        }
      }
      const updated = await updateGroupDM(
        session.url,
        groupDM.id,
        { name: name.trim(), avatar: avatarPayload },
      )
      setGroupDMChannels(groupDMChannels.map((c) => (c.id === updated.id ? updated : c)))
      setAvatarChanged(false)
      pendingAvatarFile.current = null
      setRemovingAvatar(false)
      setMsg('saved')
      setTimeout(() => setMsg(null), 3000)
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string }
      setMsg(e?.response?.data?.error || e?.message || 'Failed to save')
    }
    setSaving(false)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Group Settings"
      footer={() => isOwner ? (
        <button
          className="gdms__save-btn"
          onClick={handleSave}
          disabled={!name.trim() || saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      ) : undefined}
    >
      <div className="gdms__avatar-section">
        <div className="gdms__avatar-wrap">
          {avatarPreview ? (
            <img src={avatarPreview} alt="" className="gdms__avatar-img" />
          ) : (
            <span className="gdms__avatar-placeholder">{groupDM.name.slice(0, 2).toUpperCase()}</span>
          )}
          {isOwner && (
            <>
              <label className="gdms__avatar-overlay" title="Change avatar">
                <Camera size={14} />
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarFile}
                  className="gdms__avatar-input"
                />
              </label>
              {avatarPreview && (
                <button
                  className="gdms__avatar-remove"
                  onClick={handleRemoveAvatar}
                  title="Remove avatar"
                >
                  <X size={10} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="gdms__field">
        <label className="gdms__label">Group Name</label>
        {isOwner ? (
          <input
            ref={nameRef}
            className="gdms__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        ) : (
          <span className="gdms__value">{groupDM.name}</span>
        )}
      </div>

      <div className="gdms__field">
        <label className="gdms__label">
          <Users size={10} style={{ marginRight: 4, verticalAlign: -1 }} />
          Members ({groupDM.members.length})
        </label>
        <div className="gdms__member-list">
          {groupDM.members.map((member) => {
            const memberInfo = members.find((m) => m.id === member.user_id)
            const displayName = memberInfo?.display_name || memberInfo?.username || member.user_id
            const isOwnerBadge = member.user_id === groupDM.owner_id

            return (
              <div key={member.user_id} className="gdms__member">
                <div className="gdms__member-avatar">
                  {memberInfo?.avatar ? (
                    <img src={memberInfo.avatar} alt="" />
                  ) : (
                    displayName[0]?.toUpperCase() || '?'
                  )}
                </div>
                <div className="gdms__member-info">
                  <span className="gdms__member-name">
                    {displayName}
                    {isOwnerBadge && <span className="gdms__member-owner" title="Owner"> 👑</span>}
                  </span>
                  <span className="gdms__member-username">@{memberInfo?.username || member.user_id}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {msg && (
        <p className={`gdms__msg ${msg === 'saved' ? 'gdms__msg--success' : 'gdms__msg--error'}`}>
          {msg === 'saved' ? 'Settings saved' : msg}
        </p>
      )}
    </Modal>
  )
}
