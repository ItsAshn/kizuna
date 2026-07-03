import { useEffect, useState } from 'react'
import type { Channel, CustomRole } from '@kizuna/shared'
import { fetchRoles, lockChannel, hideChannel } from '@kizuna/shared'
import Modal from './ui/Modal'
import ToggleSwitch from './ui/ToggleSwitch'
import Checkbox from './ui/Checkbox'
import { useServerStore } from '../store/serverStore'
import './ChannelAccessModal.css'

interface Props {
  channel: Channel
  onClose: () => void
}

export default function ChannelAccessModal({ channel, onClose }: Props) {
  const session = useServerStore((s) => s.activeSession)
  const serverUrl = session?.url

  const [locked, setLocked] = useState(channel.locked)
  const [hidden, setHidden] = useState(channel.hidden)
  const [hiddenRoleIds, setHiddenRoleIds] = useState<string[]>(channel.hidden_role_ids ?? [])
  const [roles, setRoles] = useState<CustomRole[]>([])
  const [loading, setLoading] = useState(true)
  const [savingLock, setSavingLock] = useState(false)
  const [savingHide, setSavingHide] = useState(false)

  useEffect(() => {
    if (!serverUrl) return
    fetchRoles(serverUrl)
      .then(setRoles)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [serverUrl])

  async function handleLockChange(on: boolean) {
    if (!serverUrl) return
    setSavingLock(true)
    try {
      await lockChannel(serverUrl, channel.id, on)
      setLocked(on)
    } catch (err) {
      console.error('Failed to toggle lock:', err)
    } finally {
      setSavingLock(false)
    }
  }

  async function handleHideChange(on: boolean, roleIds?: string[]) {
    if (!serverUrl) return
    const ids = roleIds ?? hiddenRoleIds
    setSavingHide(true)
    try {
      await hideChannel(serverUrl, channel.id, on, ids.length > 0 ? ids : null)
      setHidden(on)
      setHiddenRoleIds(ids)
    } catch (err) {
      console.error('Failed to toggle hide:', err)
    } finally {
      setSavingHide(false)
    }
  }

  function toggleRole(roleId: string) {
    setHiddenRoleIds((prev) => {
      const next = prev.includes(roleId)
        ? prev.filter((id) => id !== roleId)
        : [...prev, roleId]
      handleHideChange(true, next)
      return next
    })
  }

  return (
    <Modal open onClose={onClose} title={`#${channel.name} Access`}>
      <div className="channel-access">
        <div className="channel-access__section">
          <div className="channel-access__row">
            <div className="channel-access__info">
              <span className="channel-access__label">Lock channel</span>
              <span className="channel-access__desc">
                Only admins can send messages. Everyone can still read.
              </span>
            </div>
            <ToggleSwitch
              checked={locked}
              onChange={handleLockChange}
              disabled={savingLock}
              ariaLabel="Lock channel"
            />
          </div>
        </div>

        <div className="channel-access__divider" />

        <div className="channel-access__section">
          <div className="channel-access__row">
            <div className="channel-access__info">
              <span className="channel-access__label">Hide channel</span>
              <span className="channel-access__desc">
                Hide this channel from specific roles in the sidebar.
              </span>
            </div>
            <ToggleSwitch
              checked={hidden}
              onChange={(on) => handleHideChange(on)}
              disabled={savingHide}
              ariaLabel="Hide channel"
            />
          </div>

          {hidden && (
            <div className="channel-access__roles">
              <span className="channel-access__roles-label">Hidden from:</span>
              {loading && <span className="channel-access__loading">Loading roles...</span>}
              {!loading && roles.length === 0 && (
                <span className="channel-access__empty">No roles. Create roles in Server Settings.</span>
              )}
              {!loading && roles.map((r) => (
                <Checkbox
                  key={r.id}
                  checked={hiddenRoleIds.includes(r.id)}
                  onChange={() => toggleRole(r.id)}
                  disabled={savingHide}
                  label={r.name}
                  ariaLabel={`Hide from ${r.name}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
