import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { fetchInvites, createInvite, revokeInvite } from '@kizuna/shared'
import type { InviteCode } from '@kizuna/shared'
import { handleApiErr, useMountedRef } from './common'

const EXPIRY_OPTIONS = [
  { label: 'never', value: '0' },
  { label: '1 hour', value: '1' },
  { label: '6 hours', value: '6' },
  { label: '1 day', value: '24' },
  { label: '7 days', value: '168' },
  { label: '30 days', value: '720' },
]

export function InvitesSection({ serverUrl }: { serverUrl: string | null | undefined }) {
  const mountedRef = useMountedRef()
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [invitesLoading, setInvitesLoading] = useState(false)
  const [newMaxUses, setNewMaxUses] = useState('')
  const [newExpiry, setNewExpiry] = useState('0')
  const [creatingInvite, setCreatingInvite] = useState(false)
  const [activeQr, setActiveQr] = useState<{ code: string; dataUrl: string } | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  useEffect(() => {
    async function loadInvites() {
      if (!serverUrl) return
      setInvitesLoading(true)
      try { if (mountedRef.current) setInvites(await fetchInvites(serverUrl)) } catch (err) {
        console.error('Failed to fetch invites:', err)
      }
      if (mountedRef.current) setInvitesLoading(false)
    }
    loadInvites()
  }, [serverUrl])

  const handleCreateInvite = async () => {
    if (!serverUrl) return
    setCreatingInvite(true)
    try {
      const maxUses = newMaxUses ? parseInt(newMaxUses, 10) : undefined
      const expiresInHours = newExpiry !== '0' ? parseFloat(newExpiry) : undefined
      const invite = await createInvite(serverUrl, maxUses, expiresInHours)
      setInvites(prev => [invite, ...prev])
      const deepLink = `kizuna://join?server=${encodeURIComponent(serverUrl)}&code=${invite.code}`
      const qrDataUrl = await QRCode.toDataURL(deepLink, {
        width: 200,
        margin: 2,
        color: { dark: '#f2f3f5', light: '#1e1f22' },
      })
      setActiveQr({ code: invite.code, dataUrl: qrDataUrl })
      setNewMaxUses('')
      setNewExpiry('0')
      setInviteError(null)
    } catch (err) {
      console.error('Failed to create invite:', err)
      setInviteError(handleApiErr(err))
    }
    setCreatingInvite(false)
  }

  const handleShowQr = async (invite: InviteCode) => {
    if (activeQr?.code === invite.code) {
      setActiveQr(null)
      return
    }
    const deepLink = `kizuna://join?server=${encodeURIComponent(serverUrl!)}&code=${invite.code}`
    const qrDataUrl = await QRCode.toDataURL(deepLink, {
      width: 200,
      margin: 2,
      color: { dark: '#f2f3f5', light: '#1e1f22' },
    })
    setActiveQr({ code: invite.code, dataUrl: qrDataUrl })
  }

  const handleRevokeInvite = async (code: string) => {
    if (!serverUrl) return
    try {
      await revokeInvite(serverUrl, code)
      setInvites(prev => prev.filter(i => i.code !== code))
    } catch (err) {
      console.error('Failed to revoke invite:', err)
      setInviteError(handleApiErr(err))
    }
  }

  return (
    <div className="server-menu__section">
      <div className="server-menu__invite-create">
        <p className="server-menu__section-title" style={{ marginBottom: '8px' }}>create invite</p>
        <div className="server-menu__invite-row">
          <div className="server-menu__field">
            <label className="server-menu__label">max uses (blank = infinite)</label>
            <input type="number" min="1" className="server-menu__input" placeholder="unlimited" value={newMaxUses} onChange={(e) => setNewMaxUses(e.target.value)} />
          </div>
          <div className="server-menu__field">
            <label className="server-menu__label">expires after</label>
            <select className="server-menu__select" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)}>
              {EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <button onClick={handleCreateInvite} disabled={creatingInvite} className="server-menu__role-create-btn">
          {creatingInvite ? '...' : 'generate invite code'}
        </button>
        {inviteError && (
          <span className="server-menu__save-msg server-menu__save-msg--err" style={{ marginTop: '6px', display: 'block' }}>{inviteError}</span>
        )}
      </div>

      {activeQr && (
        <div className="server-menu__qr-panel">
          <p className="server-menu__section-title">invite code</p>
          <img src={activeQr.dataUrl} alt="QR" className="server-menu__qr-img" />
          <div className="server-menu__qr-code-row">
            <code className="server-menu__qr-code">{activeQr.code}</code>
            <button
              onClick={() => navigator.clipboard.writeText(activeQr.code)}
              className="server-menu__qr-copy-btn"
            >
              copy
            </button>
          </div>
          <p className="server-menu__qr-hint">share this code — recipients join with just the code</p>
          <button onClick={() => setActiveQr(null)} className="server-menu__qr-dismiss-btn">
            dismiss
          </button>
        </div>
      )}

      <p className="server-menu__section-title">active codes ({invites.length})</p>
      {invitesLoading ? (
        <p className="server-menu__loading">loading...</p>
      ) : invites.length === 0 ? (
        <p className="server-menu__loading">no active invite codes</p>
      ) : (
        invites.map(inv => (
          <div key={inv.code} className="server-menu__invite-item">
            <code className="server-menu__invite-code">{inv.code}</code>
            <div className="server-menu__invite-stats">
              <div>{inv.uses}/{inv.max_uses ?? '∞'} uses</div>
              <div>{inv.expires_at ? new Date(inv.expires_at * 1000).toLocaleDateString() : 'never'}</div>
            </div>
            <div className="server-menu__invite-actions">
              <button onClick={() => handleShowQr(inv)} className={`server-menu__invite-qr-btn ${activeQr?.code === inv.code ? 'server-menu__invite-qr-btn--active' : ''}`}>
                qr
              </button>
              <button onClick={() => { if (activeQr?.code === inv.code) setActiveQr(null); handleRevokeInvite(inv.code) }} className="server-menu__invite-revoke">revoke</button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
