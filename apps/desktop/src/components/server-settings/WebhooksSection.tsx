import { useServerStore } from '../../store/serverStore'
import WebhookManager from '../webhooks/WebhookManager'

export function WebhooksSection() {
  const session = useServerStore((s) => s.activeSession)

  return (
    <div className="server-menu__settings-group">
      <p className="server-menu__settings-group-title">incoming webhooks</p>
      <WebhookManager serverUrl={session?.url} />
    </div>
  )
}
