import { useEffect, useState, useCallback } from 'react'
import { useServerStore } from '../../store/serverStore'
import { useChatStore } from '../../store/chatStore'
import {
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
} from '@kizuna/shared'

import { handleApiErr } from './common'
import './WebhooksSection.css'

export function WebhooksSection() {
  const session = useServerStore((s) => s.activeSession)
  const channels = useChatStore((s) => s.channels)
  const [webhooks, setWebhooks] = useState<{ id: string; name: string; token: string; channel_id: string; created_at: number }[]>([])
  const [newName, setNewName] = useState('')
  const [newChannelId, setNewChannelId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    if (channels.length > 0 && !newChannelId) {
      const first = channels.find((c) => c.type === 'text')
      if (first) setNewChannelId(first.id)
    }
  }, [channels])

  const loadWebhooks = useCallback((channelId: string) => {
    if (!session) return
    fetchWebhooks(session.url, channelId).then((r) => setWebhooks(r.webhooks)).catch(() => {})
  }, [session])

  useEffect(() => {
    if (!newChannelId || !session) return
    loadWebhooks(newChannelId)
  }, [newChannelId, session, loadWebhooks])

  const handleCreate = async () => {
    if (!newName.trim() || !newChannelId || !session) return
    setLoading(true); setError('')
    try {
      await createWebhook(session.url, newChannelId, newName.trim())
      setNewName('')
      loadWebhooks(newChannelId)
    } catch (err) { setError(handleApiErr(err)) } finally { setLoading(false) }
  }

  const handleDelete = async (id: string) => {
    if (!session) return
    try {
      await deleteWebhook(session.url, id)
      setWebhooks((prev) => prev.filter((w) => w.id !== id))
    } catch (err) { setError(handleApiErr(err)) }
  }

  const handleCopy = async (token: string, id: string) => {
    try {
      await navigator.clipboard.writeText(`${session?.url ?? ''}/api/webhooks/incoming/${token}`)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch { /* ignore */ }
  }

  const textChannels = channels.filter((c) => c.type === 'text')
  const getChannelName = (channelId: string) => channels.find((c) => c.id === channelId)?.name ?? 'unknown'

  return (
    <>
      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">incoming webhooks</p>
        <p className="server-menu__css-hint" style={{ marginBottom: '12px' }}>
          Post messages to a channel from external services. Use the URL below to send messages from bots, CI/CD, or GitHub.
        </p>

        <div className="server-menu__field">
          <label className="server-menu__label">channel</label>
          <select
            className="server-menu__select"
            value={newChannelId}
            onChange={(e) => setNewChannelId(e.target.value)}
          >
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>
        <div className="server-menu__field">
          <label className="server-menu__label">name</label>
          <input
            className="server-menu__input"
            placeholder="My Bot"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>

        <div className="server-menu__save-row" style={{ marginTop: '8px' }}>
          <button className="server-menu__save-btn" onClick={handleCreate} disabled={loading || !newName.trim()}>
            {loading ? 'creating...' : 'create webhook'}
          </button>
          {error && (
            <span className="server-menu__save-msg server-menu__save-msg--err">{error}</span>
          )}
        </div>
      </div>

      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">active webhooks ({webhooks.length})</p>
        {webhooks.length > 0 ? (
          webhooks.map((wh) => (
            <div key={wh.id} className="server-menu__webhook-item">
              <div className="server-menu__webhook-item-info">
                <span className="server-menu__webhook-item-name">{wh.name}</span>
                <span className="server-menu__webhook-item-channel">
                  #{getChannelName(wh.channel_id)}
                </span>
                <span className="server-menu__webhook-item-date">
                  {new Date(wh.created_at * 1000).toLocaleDateString()}
                </span>
              </div>
              <div className="server-menu__webhook-item-actions">
                <button
                  className={`server-menu__save-btn${copiedId === wh.id ? ' server-menu__save-btn--copied' : ''}`}
                  onClick={() => handleCopy(wh.token, wh.id)}
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                >
                  {copiedId === wh.id ? 'copied!' : 'copy url'}
                </button>
                <button className="server-menu__btn server-menu__btn--danger" onClick={() => handleDelete(wh.id)}>
                  delete
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="server-menu__loading">no webhooks configured</p>
        )}
      </div>
    </>
  )
}

