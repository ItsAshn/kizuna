import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  RefreshCw,
  Trash2,
  Webhook as WebhookIcon,
} from 'lucide-react'
import {
  createWebhook,
  deleteWebhook,
  fetchAllWebhooks,
  fetchWebhooks,
  regenerateWebhookToken,
  updateWebhook,
  webhookUrl,
} from '@kizuna/shared'
import type { Webhook } from '@kizuna/shared'
import { useChatStore } from '../../store/chatStore'
import Avatar from '../ui/Avatar'
import Button from '../ui/Button'
import IconButton from '../ui/IconButton'
import Input from '../ui/Input'
import Select from '../ui/Select'
import { handleApiErr, useMountedRef } from '../server-settings/common'
import './WebhookManager.css'

interface Props {
  serverUrl: string | null | undefined
  /** Scope to one channel (channel settings). Omitted = every manageable webhook. */
  channel?: { id: string; name: string }
}

function relativeTime(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return 'never'
  const diff = Date.now() / 1000 - epochSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 2_592_000) return `${Math.floor(diff / 86_400)}d ago`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}

function maskUrl(url: string): string {
  const cut = url.lastIndexOf('/') + 1
  return `${url.slice(0, cut)}${'•'.repeat(24)}`
}

/**
 * The single source of truth for webhook management, shared by channel settings
 * (scoped to one channel) and server settings (all channels). Tokens stay
 * masked until revealed, and every destructive action asks first.
 */
export default function WebhookManager({ serverUrl, channel }: Props) {
  const mountedRef = useMountedRef()
  const channels = useChatStore((s) => s.channels)
  const textChannels = useMemo(() => channels.filter((ch) => ch.type === 'text'), [channels])

  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [newName, setNewName] = useState('')
  const [newChannelId, setNewChannelId] = useState(channel?.id ?? '')
  const [creating, setCreating] = useState(false)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string; avatar: string } | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [pendingAction, setPendingAction] = useState<{
    id: string
    kind: 'delete' | 'regenerate'
  } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (channel || newChannelId) return
    const first = textChannels[0]
    if (first) setNewChannelId(first.id)
  }, [channel, newChannelId, textChannels])

  const load = useCallback(async () => {
    if (!serverUrl) return
    setLoading(true)
    try {
      const list = channel
        ? await fetchWebhooks(serverUrl, channel.id)
        : await fetchAllWebhooks(serverUrl)
      if (!mountedRef.current) return
      setWebhooks(list)
      setError('')
    } catch (err) {
      // A load failure is usually "you lost manage_channels" — say so rather
      // than rendering an empty list that looks like "no webhooks yet".
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [serverUrl, channel?.id])

  useEffect(() => {
    load()
  }, [load])

  const channelName = useCallback(
    (webhook: Webhook) =>
      webhook.channel_name ??
      channels.find((ch) => ch.id === webhook.channel_id)?.name ??
      'unknown',
    [channels],
  )

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => {
        if (mountedRef.current) setCopiedId(null)
      }, 2000)
    } catch {
      setError('clipboard unavailable — reveal the url and copy it manually')
    }
  }

  const handleCreate = async () => {
    const targetChannel = channel?.id ?? newChannelId
    if (!serverUrl || !newName.trim() || !targetChannel) return
    setCreating(true)
    setError('')
    try {
      const webhook = await createWebhook(serverUrl, targetChannel, newName.trim())
      if (!mountedRef.current) return
      setWebhooks((prev) => [webhook, ...prev])
      setNewName('')
      // Open and reveal the new one — the URL is the entire point of creating it.
      setExpandedId(webhook.id)
      setRevealedId(webhook.id)
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  const handleSaveEdit = async () => {
    if (!serverUrl || !editing || !editing.name.trim()) return
    setSavingEdit(true)
    setError('')
    try {
      const updated = await updateWebhook(serverUrl, editing.id, {
        name: editing.name.trim(),
        avatar: editing.avatar.trim() || null,
      })
      if (!mountedRef.current) return
      setWebhooks((prev) => prev.map((w) => (w.id === updated.id ? updated : w)))
      setEditing(null)
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) setSavingEdit(false)
    }
  }

  const handleRegenerate = async (id: string) => {
    if (!serverUrl) return
    setBusyId(id)
    setError('')
    try {
      const updated = await regenerateWebhookToken(serverUrl, id)
      if (!mountedRef.current) return
      setWebhooks((prev) => prev.map((w) => (w.id === id ? updated : w)))
      setExpandedId(id)
      setRevealedId(id)
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) {
        setBusyId(null)
        setPendingAction(null)
      }
    }
  }

  const handleDelete = async (id: string) => {
    if (!serverUrl) return
    setBusyId(id)
    setError('')
    try {
      await deleteWebhook(serverUrl, id)
      if (!mountedRef.current) return
      setWebhooks((prev) => prev.filter((w) => w.id !== id))
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) {
        setBusyId(null)
        setPendingAction(null)
      }
    }
  }

  const canCreate = !!newName.trim() && !!(channel?.id ?? newChannelId)

  return (
    <div className="webhook-mgr">
      <p className="webhook-mgr__intro">
        Incoming webhooks let external services post into{' '}
        {channel ? <>#{channel.name}</> : 'a channel'} — CI results, GitHub activity, alerts, or
        anything that can send an HTTP request. Anyone holding the URL can post, so treat it like a
        password.
      </p>

      <div className="webhook-mgr__create">
        <div className="webhook-mgr__create-fields">
          <Input
            label="name"
            placeholder="Deploy Bot"
            value={newName}
            maxLength={80}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) handleCreate()
            }}
          />
          {!channel && (
            <Select
              id="webhook-channel"
              label="channel"
              value={newChannelId}
              onChange={(e) => setNewChannelId(e.target.value)}
            >
              {textChannels.length === 0 && <option value="">no text channels</option>}
              {textChannels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  #{ch.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <Button onClick={handleCreate} loading={creating} disabled={!canCreate}>
          create webhook
        </Button>
      </div>

      {error && (
        <p className="webhook-mgr__error" role="alert">
          {error}
        </p>
      )}

      <div className="webhook-mgr__list-head">
        <span className="webhook-mgr__list-title">
          {channel ? 'webhooks in this channel' : 'all webhooks'} ({webhooks.length})
        </span>
      </div>

      {loading ? (
        <p className="webhook-mgr__empty">loading…</p>
      ) : webhooks.length === 0 ? (
        <div className="webhook-mgr__empty-state">
          <WebhookIcon size={20} aria-hidden />
          <p>No webhooks yet. Create one above to get a URL you can paste into another service.</p>
        </div>
      ) : (
        webhooks.map((webhook) => {
          const url = webhookUrl(serverUrl ?? '', webhook.token)
          const isExpanded = expandedId === webhook.id
          const isRevealed = revealedId === webhook.id
          const isEditing = editing?.id === webhook.id
          const confirm = pendingAction?.id === webhook.id ? pendingAction.kind : null

          return (
            <div
              key={webhook.id}
              className={`webhook-mgr__item${isExpanded ? ' webhook-mgr__item--open' : ''}`}
            >
              <div className="webhook-mgr__row">
                <Avatar src={webhook.avatar} name={webhook.name} size={32} serverUrl={serverUrl} />
                <div className="webhook-mgr__meta">
                  <span className="webhook-mgr__name">{webhook.name}</span>
                  <span className="webhook-mgr__sub">
                    #{channelName(webhook)}
                    {webhook.created_by_username && <> · by @{webhook.created_by_username}</>}
                    {' · last used '}
                    {relativeTime(webhook.last_used_at)}
                  </span>
                </div>
                <div className="webhook-mgr__actions">
                  <IconButton
                    size="sm"
                    icon={copiedId === webhook.id ? <Check size={14} /> : <Copy size={14} />}
                    label="copy webhook url"
                    title="copy url"
                    onClick={() => handleCopy(webhook.id, url)}
                  />
                  <IconButton
                    size="sm"
                    icon={
                      <ChevronDown
                        size={14}
                        className={isExpanded ? 'webhook-mgr__chevron--open' : ''}
                      />
                    }
                    label={isExpanded ? 'hide details' : 'show details'}
                    title="details"
                    active={isExpanded}
                    onClick={() => setExpandedId(isExpanded ? null : webhook.id)}
                  />
                </div>
              </div>

              {isExpanded && (
                <div className="webhook-mgr__details">
                  <div className="webhook-mgr__url-row">
                    <code className="webhook-mgr__url">{isRevealed ? url : maskUrl(url)}</code>
                    <IconButton
                      size="sm"
                      icon={isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                      label={isRevealed ? 'hide token' : 'reveal token'}
                      onClick={() => setRevealedId(isRevealed ? null : webhook.id)}
                    />
                  </div>

                  {isEditing ? (
                    <div className="webhook-mgr__edit">
                      <Input
                        label="name"
                        value={editing.name}
                        maxLength={80}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      />
                      <Input
                        label="avatar url (optional)"
                        placeholder="https://example.com/icon.png"
                        value={editing.avatar}
                        onChange={(e) => setEditing({ ...editing, avatar: e.target.value })}
                      />
                      <div className="webhook-mgr__edit-actions">
                        <Button
                          size="sm"
                          onClick={handleSaveEdit}
                          loading={savingEdit}
                          disabled={!editing.name.trim()}
                        >
                          save
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(null)}>
                          cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="webhook-mgr__hint">
                        POST JSON to this URL. Payloads may use <code>content</code> (plain text),
                        Discord-style <code>embeds</code>, or Slack-style <code>text</code>. GitHub
                        webhooks are formatted automatically — set the content type to
                        <code> application/json</code>. Per-message <code>username</code> and{' '}
                        <code>avatar_url</code> override the defaults below.
                      </p>
                      <pre className="webhook-mgr__snippet">
                        {`curl -X POST '${isRevealed ? url : maskUrl(url)}' \\
  -H 'Content-Type: application/json' \\
  -d '{"content":"hello from ${webhook.name}"}'`}
                      </pre>
                      <div className="webhook-mgr__detail-actions">
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<Pencil size={13} />}
                          onClick={() =>
                            setEditing({
                              id: webhook.id,
                              name: webhook.name,
                              avatar: webhook.avatar ?? '',
                            })
                          }
                        >
                          edit
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon={<RefreshCw size={13} />}
                          onClick={() => setPendingAction({ id: webhook.id, kind: 'regenerate' })}
                        >
                          regenerate url
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          leadingIcon={<Trash2 size={13} />}
                          onClick={() => setPendingAction({ id: webhook.id, kind: 'delete' })}
                        >
                          delete
                        </Button>
                      </div>
                    </>
                  )}

                  {confirm && (
                    <div className="webhook-mgr__confirm">
                      <span>
                        {confirm === 'delete'
                          ? `Delete "${webhook.name}"? Anything posting to it will stop working.`
                          : 'Regenerate the URL? The current one stops working immediately.'}
                      </span>
                      <div className="webhook-mgr__confirm-actions">
                        <Button
                          size="sm"
                          variant={confirm === 'delete' ? 'danger' : 'primary'}
                          loading={busyId === webhook.id}
                          onClick={() =>
                            confirm === 'delete'
                              ? handleDelete(webhook.id)
                              : handleRegenerate(webhook.id)
                          }
                        >
                          {confirm === 'delete' ? 'delete' : 'regenerate'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setPendingAction(null)}
                        >
                          cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
