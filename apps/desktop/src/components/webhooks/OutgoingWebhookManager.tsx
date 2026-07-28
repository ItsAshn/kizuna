import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react'
import {
  OUTGOING_WEBHOOK_EVENTS,
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  fetchOutgoingWebhookDeliveries,
  fetchOutgoingWebhooks,
  isChannelScopedEvent,
  regenerateOutgoingWebhookSecret,
  testOutgoingWebhook,
  updateOutgoingWebhook,
} from '@kizuna/shared'
import type {
  OutgoingWebhook,
  OutgoingWebhookDelivery,
  OutgoingWebhookEvent,
  OutgoingWebhookFormat,
  OutgoingWebhookTestResult,
} from '@kizuna/shared'
import { useChatStore } from '../../store/chatStore'
import Button from '../ui/Button'
import Checkbox from '../ui/Checkbox'
import IconButton from '../ui/IconButton'
import Input from '../ui/Input'
import ToggleSwitch from '../ui/ToggleSwitch'
import { handleApiErr, useMountedRef } from '../server-settings/common'
import './OutgoingWebhookManager.css'

interface Props {
  serverUrl: string | null | undefined
  /** Scope to one channel (channel settings). Omitted = every outgoing webhook. */
  channel?: { id: string; name: string }
}

const FORMAT_LABELS: Record<OutgoingWebhookFormat, string> = {
  kizuna: 'Kizuna (signed JSON)',
  discord: 'Discord-compatible',
  slack: 'Slack-compatible',
}

/** Events that make sense for the current scope — see isChannelScopedEvent. */
function eventsForScope(scoped: boolean) {
  return scoped ? OUTGOING_WEBHOOK_EVENTS.filter((e) => e.channelScoped) : OUTGOING_WEBHOOK_EVENTS
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

function maskSecret(secret: string): string {
  return `${secret.slice(0, 6)}${'•'.repeat(24)}`
}

/** Host only — the full URL can be long and is shown in the details panel. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function statusTone(webhook: OutgoingWebhook): 'ok' | 'fail' | 'idle' {
  if (webhook.last_delivery_at === null) return 'idle'
  if (webhook.last_status !== null && webhook.last_status >= 200 && webhook.last_status < 300)
    return 'ok'
  return 'fail'
}

/**
 * Management UI for outgoing webhooks — this server POSTing events to an
 * external URL. Shared by server settings (all webhooks) and channel settings
 * (scoped to one channel), mirroring WebhookManager's structure.
 */
export default function OutgoingWebhookManager({ serverUrl, channel }: Props) {
  const mountedRef = useMountedRef()
  const channels = useChatStore((s) => s.channels)
  const textChannels = useMemo(() => channels.filter((ch) => ch.type === 'text'), [channels])

  const [webhooks, setWebhooks] = useState<OutgoingWebhook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newChannelId, setNewChannelId] = useState(channel?.id ?? '')
  const [newFormat, setNewFormat] = useState<OutgoingWebhookFormat>('kizuna')
  const [newEvents, setNewEvents] = useState<OutgoingWebhookEvent[]>(['message.created'])
  const [creating, setCreating] = useState(false)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<{
    id: string
    kind: 'delete' | 'regenerate'
  } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, OutgoingWebhookTestResult>>({})
  const [deliveries, setDeliveries] = useState<Record<string, OutgoingWebhookDelivery[]>>({})

  // A channel-scoped webhook can only subscribe to channel-scoped events, so
  // drop any selection that stops being valid when the scope changes.
  const createScoped = !!(channel?.id ?? newChannelId)
  useEffect(() => {
    setNewEvents((prev) => {
      const allowed = prev.filter((e) => !createScoped || isChannelScopedEvent(e))
      return allowed.length === prev.length ? prev : allowed
    })
  }, [createScoped])

  const load = useCallback(async () => {
    if (!serverUrl) return
    setLoading(true)
    try {
      const list = await fetchOutgoingWebhooks(serverUrl, channel?.id)
      if (!mountedRef.current) return
      setWebhooks(list)
      setError('')
    } catch (err) {
      // Usually "you lost manage_webhooks" — say so rather than rendering an
      // empty list that reads as "none configured".
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [serverUrl, channel?.id])

  useEffect(() => {
    load()
  }, [load])

  const channelName = useCallback(
    (webhook: OutgoingWebhook) =>
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
      setError('clipboard unavailable — reveal the secret and copy it manually')
    }
  }

  const handleCreate = async () => {
    if (!serverUrl || !canCreate) return
    setCreating(true)
    setError('')
    try {
      const webhook = await createOutgoingWebhook(serverUrl, {
        name: newName.trim(),
        url: newUrl.trim(),
        channel_id: channel?.id ?? (newChannelId || null),
        events: newEvents,
        format: newFormat,
      })
      if (!mountedRef.current) return
      setWebhooks((prev) => [webhook, ...prev])
      setNewName('')
      setNewUrl('')
      setExpandedId(webhook.id)
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) setCreating(false)
    }
  }

  const patch = async (id: string, data: Parameters<typeof updateOutgoingWebhook>[2]) => {
    if (!serverUrl) return
    setError('')
    try {
      const updated = await updateOutgoingWebhook(serverUrl, id, data)
      if (!mountedRef.current) return
      setWebhooks((prev) => prev.map((w) => (w.id === id ? updated : w)))
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    }
  }

  const handleRegenerate = async (id: string) => {
    if (!serverUrl) return
    setBusyId(id)
    setError('')
    try {
      const updated = await regenerateOutgoingWebhookSecret(serverUrl, id)
      if (!mountedRef.current) return
      setWebhooks((prev) => prev.map((w) => (w.id === id ? updated : w)))
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
      await deleteOutgoingWebhook(serverUrl, id)
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

  const handleTest = async (id: string) => {
    if (!serverUrl) return
    setTesting(id)
    setError('')
    try {
      const result = await testOutgoingWebhook(serverUrl, id)
      if (!mountedRef.current) return
      setTestResults((prev) => ({ ...prev, [id]: result }))
      // A test updates last_status/last_error, so pull both the row and the log.
      await Promise.all([load(), loadDeliveries(id)])
    } catch (err) {
      if (mountedRef.current) setError(handleApiErr(err))
    } finally {
      if (mountedRef.current) setTesting(null)
    }
  }

  const loadDeliveries = useCallback(
    async (id: string) => {
      if (!serverUrl) return
      try {
        const list = await fetchOutgoingWebhookDeliveries(serverUrl, id)
        if (mountedRef.current) setDeliveries((prev) => ({ ...prev, [id]: list }))
      } catch {
        /* the panel simply stays empty */
      }
    },
    [serverUrl],
  )

  const toggleExpanded = (id: string) => {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    if (next) loadDeliveries(next)
  }

  const toggleNewEvent = (event: OutgoingWebhookEvent) => {
    setNewEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    )
  }

  const canCreate = !!newName.trim() && !!newUrl.trim() && newEvents.length > 0

  return (
    <div className="webhook-mgr">
      <p className="webhook-mgr__intro">
        Outgoing webhooks POST to an external URL when things happen{' '}
        {channel ? <>in #{channel.name}</> : 'on this server'} — bridge a channel into Discord or
        Slack, or feed an automation service. Kizuna-format payloads are signed with{' '}
        <code>X-Kizuna-Signature</code> so the receiver can verify they came from you.
      </p>

      <div className="webhook-mgr__create">
        <div className="webhook-mgr__create-fields">
          <Input
            label="name"
            placeholder="Discord bridge"
            value={newName}
            maxLength={80}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Input
            label="target url"
            placeholder="https://discord.com/api/webhooks/…"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
          />
        </div>

        <div className="webhook-mgr__create-fields">
          {!channel && (
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="owh-channel">
                scope
              </label>
              <select
                id="owh-channel"
                className="webhook-mgr__select"
                value={newChannelId}
                onChange={(e) => setNewChannelId(e.target.value)}
              >
                <option value="">all channels (server-wide)</option>
                {textChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="owh-format">
              payload format
            </label>
            <select
              id="owh-format"
              className="webhook-mgr__select"
              value={newFormat}
              onChange={(e) => setNewFormat(e.target.value as OutgoingWebhookFormat)}
            >
              {(Object.keys(FORMAT_LABELS) as OutgoingWebhookFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="owh__events">
          <span className="ui-field__label">events</span>
          <div className="owh__event-grid">
            {eventsForScope(createScoped).map((evt) => (
              <Checkbox
                key={evt.key}
                checked={newEvents.includes(evt.key)}
                onChange={() => toggleNewEvent(evt.key)}
                label={evt.label}
                ariaLabel={evt.desc}
              />
            ))}
          </div>
          {createScoped && (
            <p className="owh__hint">
              Channel-scoped webhooks only receive events from that channel. Pick “all channels” for
              server-wide events like members joining.
            </p>
          )}
        </div>

        <Button onClick={handleCreate} loading={creating} disabled={!canCreate}>
          create outgoing webhook
        </Button>
      </div>

      {error && (
        <p className="webhook-mgr__error" role="alert">
          {error}
        </p>
      )}

      <div className="webhook-mgr__list-head">
        <span className="webhook-mgr__list-title">
          {channel ? 'outgoing from this channel' : 'all outgoing webhooks'} ({webhooks.length})
        </span>
      </div>

      {loading ? (
        <p className="webhook-mgr__empty">loading…</p>
      ) : webhooks.length === 0 ? (
        <div className="webhook-mgr__empty-state">
          <Send size={20} aria-hidden />
          <p>No outgoing webhooks yet. Create one above to push events to another service.</p>
        </div>
      ) : (
        webhooks.map((webhook) => {
          const isExpanded = expandedId === webhook.id
          const isRevealed = revealedId === webhook.id
          const confirm = pendingAction?.id === webhook.id ? pendingAction.kind : null
          const tone = statusTone(webhook)
          const test = testResults[webhook.id]
          const rows = deliveries[webhook.id] ?? []
          const allowed = eventsForScope(!!webhook.channel_id)

          return (
            <div
              key={webhook.id}
              className={`webhook-mgr__item${isExpanded ? ' webhook-mgr__item--open' : ''}`}
            >
              <div className="webhook-mgr__row">
                <span className={`owh__status owh__status--${tone}`} aria-hidden />
                <div className="webhook-mgr__meta">
                  <span className="webhook-mgr__name">{webhook.name}</span>
                  <span className="webhook-mgr__sub">
                    {hostOf(webhook.url)}
                    {' · '}
                    {webhook.channel_id ? `#${channelName(webhook)}` : 'all channels'}
                    {' · '}
                    {webhook.events.length} event{webhook.events.length === 1 ? '' : 's'}
                    {' · last '}
                    {relativeTime(webhook.last_delivery_at)}
                    {webhook.last_status !== null && ` (${webhook.last_status})`}
                  </span>
                </div>
                <div className="webhook-mgr__actions">
                  <ToggleSwitch
                    checked={webhook.enabled}
                    onChange={(enabled) => patch(webhook.id, { enabled })}
                    ariaLabel={webhook.enabled ? 'disable webhook' : 'enable webhook'}
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
                    onClick={() => toggleExpanded(webhook.id)}
                  />
                </div>
              </div>

              {webhook.disabled_reason && (
                <div className="owh__banner" role="status">
                  <AlertTriangle size={14} aria-hidden />
                  <span>{webhook.disabled_reason} — fix the endpoint, then re-enable it.</span>
                </div>
              )}

              {isExpanded && (
                <div className="webhook-mgr__details">
                  <div className="ui-field">
                    <label className="ui-field__label">target url</label>
                    <code className="webhook-mgr__url">{webhook.url}</code>
                  </div>

                  <div className="ui-field">
                    <label className="ui-field__label">signing secret</label>
                    <div className="webhook-mgr__url-row">
                      <code className="webhook-mgr__url">
                        {isRevealed ? webhook.secret : maskSecret(webhook.secret)}
                      </code>
                      <IconButton
                        size="sm"
                        icon={isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                        label={isRevealed ? 'hide secret' : 'reveal secret'}
                        onClick={() => setRevealedId(isRevealed ? null : webhook.id)}
                      />
                      <IconButton
                        size="sm"
                        icon={copiedId === webhook.id ? <Check size={14} /> : <Copy size={14} />}
                        label="copy signing secret"
                        title="copy secret"
                        onClick={() => handleCopy(webhook.id, webhook.secret)}
                      />
                    </div>
                  </div>

                  <div className="owh__events">
                    <span className="ui-field__label">events</span>
                    <div className="owh__event-grid">
                      {allowed.map((evt) => (
                        <Checkbox
                          key={evt.key}
                          checked={webhook.events.includes(evt.key)}
                          onChange={(checked) =>
                            patch(webhook.id, {
                              events: checked
                                ? [...webhook.events, evt.key]
                                : webhook.events.filter((e) => e !== evt.key),
                            })
                          }
                          label={evt.label}
                          ariaLabel={evt.desc}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="webhook-mgr__create-fields">
                    <div className="ui-field">
                      <label className="ui-field__label" htmlFor={`owh-fmt-${webhook.id}`}>
                        payload format
                      </label>
                      <select
                        id={`owh-fmt-${webhook.id}`}
                        className="webhook-mgr__select"
                        value={webhook.format}
                        onChange={(e) =>
                          patch(webhook.id, { format: e.target.value as OutgoingWebhookFormat })
                        }
                      >
                        {(Object.keys(FORMAT_LABELS) as OutgoingWebhookFormat[]).map((f) => (
                          <option key={f} value={f}>
                            {FORMAT_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="owh__skip">
                      <Checkbox
                        checked={webhook.skip_webhook_messages}
                        onChange={(skip_webhook_messages) =>
                          patch(webhook.id, { skip_webhook_messages })
                        }
                        label="skip bridged messages"
                        ariaLabel="skip messages that arrived via an incoming webhook"
                      />
                      <p className="owh__hint">
                        Ignore messages that arrived through an incoming webhook. Turn this on when
                        two servers bridge to each other, so they don’t echo forever.
                      </p>
                    </div>
                  </div>

                  {webhook.format === 'kizuna' && (
                    <>
                      <p className="webhook-mgr__hint">
                        Verify a delivery by recomputing the signature over{' '}
                        <code>{'`${timestamp}.${rawBody}`'}</code> with the secret above:
                      </p>
                      <pre className="webhook-mgr__snippet">
                        {`const expected = 'sha256=' + crypto
  .createHmac('sha256', SECRET)
  .update(req.headers['x-kizuna-timestamp'] + '.' + rawBody)
  .digest('hex')
// compare against req.headers['x-kizuna-signature']`}
                      </pre>
                    </>
                  )}

                  {test && (
                    <p
                      className={`owh__test owh__test--${test.error ? 'fail' : 'ok'}`}
                      role="status"
                    >
                      {test.error
                        ? `test failed: ${test.error}`
                        : `test delivered — HTTP ${test.status} in ${test.duration_ms}ms`}
                    </p>
                  )}

                  {rows.length > 0 && (
                    <div className="owh__deliveries">
                      <span className="ui-field__label">recent deliveries</span>
                      <ul className="owh__delivery-list">
                        {rows.map((d) => (
                          <li
                            key={d.id}
                            className={`owh__delivery owh__delivery--${d.error ? 'fail' : 'ok'}`}
                          >
                            <span className="owh__delivery-event">{d.event}</span>
                            <span className="owh__delivery-status">
                              {d.status ?? 'network error'}
                            </span>
                            {d.attempt > 1 && (
                              <span className="owh__delivery-attempt">try {d.attempt}</span>
                            )}
                            <span className="owh__delivery-time">{relativeTime(d.created_at)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="webhook-mgr__detail-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Send size={13} />}
                      loading={testing === webhook.id}
                      onClick={() => handleTest(webhook.id)}
                    >
                      send test
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon={<RefreshCw size={13} />}
                      onClick={() => setPendingAction({ id: webhook.id, kind: 'regenerate' })}
                    >
                      rotate secret
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

                  {confirm && (
                    <div className="webhook-mgr__confirm">
                      <span>
                        {confirm === 'delete'
                          ? `Delete "${webhook.name}"? Events will stop being sent to ${hostOf(webhook.url)}.`
                          : 'Rotate the signing secret? Receivers verifying signatures must be updated.'}
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
                          {confirm === 'delete' ? 'delete' : 'rotate'}
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
