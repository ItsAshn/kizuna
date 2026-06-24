import { useState } from 'react'
import { fetchServerInfo, resolveInviteCode } from '@kizuna/shared'
import type { ServerInfo } from '@kizuna/shared'

interface ResolvedInviteInfo {
  serverUrl: string
  name: string
  description: string
}
import './ServerConnectForm.css'

const INVITE_CODE_RE = /^[A-Za-z0-9+\-_=]+\.[A-Za-z0-9+\-_=]+$/

function isInviteCode(input: string): boolean {
  return INVITE_CODE_RE.test(input.trim())
}

interface SavedServer {
  id: string
  name: string
  url: string
}

interface Props {
  onConnect: (resolvedUrl: string, serverInfo: ServerInfo | ResolvedInviteInfo) => void
  savedServers?: SavedServer[]
  onBack?: () => void
  backLabel?: string
}

export default function ServerConnectForm({ onConnect, savedServers = [], onBack, backLabel = 'Back' }: Props) {
  const [url, setUrl] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  async function handleConnect(urlToUse: string) {
    if (!urlToUse.trim()) return
    setConnecting(true)
    setError('')
    try {
      let resolvedUrl: string
      if (isInviteCode(urlToUse)) {
        const resolved = await resolveInviteCode(urlToUse.trim())
        resolvedUrl = resolved.serverUrl
        onConnect(resolvedUrl, resolved)
      } else {
        const info = await fetchServerInfo(urlToUse.trim())
        resolvedUrl = urlToUse.trim()
        onConnect(resolvedUrl, info)
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string }
      setError(
        e.response?.data?.error ||
          e.message ||
          'Could not reach server. Check the URL or invite code and try again.',
      )
    }
    setConnecting(false)
  }

  return (
    <div className="server-connect">
      <input
        className="input-field server-connect__input"
        placeholder="Server URL or invite code..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleConnect(url)}
        autoFocus
      />
      <button
        className="btn-primary"
        style={{ width: '100%' }}
        onClick={() => handleConnect(url)}
        disabled={connecting || !url.trim()}
      >
        {connecting ? 'Connecting...' : 'Connect'}
      </button>

      {savedServers.length > 0 && (
        <div>
          <h3 className="server-connect__saved-header">Saved Servers</h3>
          {savedServers.map((server) => (
            <button
              key={server.id}
              className="server-connect__saved-server"
              onClick={() => handleConnect(server.url)}
            >
              <span className="server-connect__saved-server-info">
                {server.name}
                <span className="server-connect__saved-server-url">{server.url}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {onBack && (
        <button
          className="btn-secondary"
          style={{ width: '100%' }}
          onClick={onBack}
        >
          {backLabel}
        </button>
      )}

      {error && <p className="server-connect__error">{error}</p>}
    </div>
  )
}
