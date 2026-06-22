import { useState, useRef, useEffect } from 'react'
import { useServerStore } from '../store/serverStore'
import { useChatStore } from '../store/chatStore'
import { createGroupDM } from '@kizuna/shared'
import { Users, X, Search } from 'lucide-react'
import './ui/Modal.css'
import './CreateGroupDMModal.css'

interface CreateGroupDMModalProps {
  onClose: () => void
}

export default function CreateGroupDMModal({ onClose }: CreateGroupDMModalProps) {
  const session = useServerStore((s) => s.activeSession)
  const members = useChatStore((s) => s.members)
  const addGroupDMChannel = useChatStore((s) => s.setGroupDMChannels)
  const existingChannels = useChatStore((s) => s.groupDMChannels)

  const [name, setName] = useState('')
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const toggleMember = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }

  const filteredMembers = members.filter((m) => {
    if (m.id === session?.user.id) return false
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return m.username.toLowerCase().includes(q) || (m.display_name || '').toLowerCase().includes(q)
  })

  const handleCreate = async () => {
    if (!session || !name.trim() || selectedIds.size < 2) return
    setCreating(true)
    setError(null)
    try {
      const channel = await createGroupDM(session.url, name.trim(), [...selectedIds])
      addGroupDMChannel([channel, ...existingChannels])
      onClose()
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to create group DM')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ width: 440 }}>
        <div className="modal__header">
          <h2 className="modal__header-title">
            <Users className="icon-sm" style={{ marginRight: 6, verticalAlign: -3 }} />
            Create Group DM
          </h2>
          <button className="modal__close-btn" onClick={onClose} aria-label="Close">
            <X className="icon-sm" />
          </button>
        </div>

        <div className="modal__body">
          <div className="cgdm__field">
            <label className="cgdm__label">Group Name</label>
            <input
              ref={nameRef}
              className="cgdm__input"
              placeholder="e.g. The Squad"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim() && selectedIds.size >= 2) handleCreate()
              }}
              maxLength={100}
            />
          </div>

          <div className="cgdm__field">
            <label className="cgdm__label">Add Members (min 2)</label>
            <div className="cgdm__search-wrap">
              <Search className="icon-xs" style={{ opacity: 0.4, marginLeft: 8 }} />
              <input
                className="cgdm__search-input"
                placeholder="Search members..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="cgdm__chips">
              {[...selectedIds].map((id) => {
                const member = members.find((m) => m.id === id)
                return (
                  <span key={id} className="cgdm__chip" onClick={() => toggleMember(id)}>
                    {member?.display_name || member?.username || id}
                    <X className="icon-xxs" style={{ marginLeft: 4, cursor: 'pointer' }} />
                  </span>
                )
              })}
            </div>
          )}

          <div className="cgdm__member-list">
            {filteredMembers.slice(0, 50).map((member) => {
              const isSelected = selectedIds.has(member.id)
              return (
                <button
                  key={member.id}
                  className={`cgdm__member ${isSelected ? 'cgdm__member--selected' : ''}`}
                  onClick={() => toggleMember(member.id)}
                >
                  <div className="cgdm__member-avatar">
                    {member.avatar ? (
                      <img src={member.avatar} alt="" />
                    ) : (
                      (member.display_name || member.username)[0]?.toUpperCase() || '?'
                    )}
                  </div>
                  <div className="cgdm__member-info">
                    <span className="cgdm__member-name">{member.display_name || member.username}</span>
                    <span className="cgdm__member-username">@{member.username}</span>
                  </div>
                  {isSelected && <span className="cgdm__check">&#10003;</span>}
                </button>
              )
            })}
            {filteredMembers.length === 0 && (
              <p className="cgdm__empty">No members found</p>
            )}
          </div>

          {error && <p className="cgdm__error">{error}</p>}

          <button
            className="cgdm__submit"
            onClick={handleCreate}
            disabled={!name.trim() || selectedIds.size < 2 || creating}
          >
            {creating ? 'Creating...' : `Create Group DM (${selectedIds.size} members)`}
          </button>
        </div>
      </div>
    </div>
  )
}
