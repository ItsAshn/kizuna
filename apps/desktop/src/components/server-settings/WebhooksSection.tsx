import { useState } from 'react'
import { useServerStore } from '../../store/serverStore'
import Tabs from '../ui/Tabs'
import WebhookManager from '../webhooks/WebhookManager'
import OutgoingWebhookManager from '../webhooks/OutgoingWebhookManager'

const TABS = [
  { key: 'incoming', label: 'incoming' },
  { key: 'outgoing', label: 'outgoing' },
]

export function WebhooksSection() {
  const session = useServerStore((s) => s.activeSession)
  const [tab, setTab] = useState('incoming')

  return (
    <div className="server-menu__settings-group">
      <p className="server-menu__settings-group-title">webhooks</p>
      <Tabs tabs={TABS} activeKey={tab} onChange={setTab} />
      {tab === 'incoming' ? (
        <WebhookManager serverUrl={session?.url} />
      ) : (
        <OutgoingWebhookManager serverUrl={session?.url} />
      )}
    </div>
  )
}
