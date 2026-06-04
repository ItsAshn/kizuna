import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useServerStore } from '../store/serverStore'
import '../styles/export-modal.css'

interface Props {
  onClose: () => void
}

export default function ExportModal({ onClose }: Props) {
  const { servers, setActiveSession } = useServerStore()
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [jsonData, setJsonData] = useState('')
  const [tab, setTab] = useState<'qr' | 'import'>('qr')
  const [importText, setImportText] = useState('')
  const [status, setStatus] = useState('')
  const [statusIsError, setStatusIsError] = useState(false)
  const [closing, setClosing] = useState(false)

  const handleClose = () => {
    if (closing) return
    setClosing(true)
    setTimeout(() => onClose(), 200)
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    const json = JSON.stringify({ servers })
    setJsonData(json)
    QRCode.toDataURL(json, {
      width: 280,
      margin: 1,
      color: { dark: '#f2f3f5', light: '#1e1f22' },
    }).then(setQrDataUrl).catch(() => setQrDataUrl(''))
  }, [servers])

  const handleCopy = () => {
    navigator.clipboard.writeText(jsonData).then(() => {
      setStatus('copied to clipboard')
      setStatusIsError(false)
    }).catch(() => {
      setStatus('failed to copy')
      setStatusIsError(true)
    })
  }

  const handleImport = () => {
    try {
      const { servers: imported } = JSON.parse(importText.trim())
      if (!Array.isArray(imported)) throw new Error('invalid format')
      const store = useServerStore.getState()
      for (const server of imported) {
        if (server.id && server.url && server.name) {
          store.addServer(server)
        }
      }
      setStatus(`imported ${imported.length} server(s)`)
      setStatusIsError(false)
    } catch {
      setStatus('invalid json — paste exported data')
      setStatusIsError(true)
    }
  }

  return (
    <div className={`modal-overlay${closing ? ' modal-overlay--closing' : ''}`} onClick={handleClose}>
      <div className={`export-modal${closing ? ' export-modal--closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="export-modal__header">
          <span className="export-modal__title">// data</span>
          <button onClick={handleClose} className="export-modal__close-btn">[esc]</button>
        </div>

        <div className="export-modal__tabs">
          <button
            onClick={() => setTab('qr')}
            className={`export-modal__tab ${tab === 'qr' ? 'export-modal__tab--active' : ''}`}
          >
            export (qr)
          </button>
          <button
            onClick={() => setTab('import')}
            className={`export-modal__tab ${tab === 'import' ? 'export-modal__tab--active' : ''}`}
          >
            import
          </button>
        </div>

        <div className="export-modal__body">
          {tab === 'qr' ? (
            <>
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Server list QR" className="export-modal__qr" />
              ) : (
                <p className="export-modal__empty-text">too many servers for qr — use json</p>
              )}
              <button onClick={handleCopy} className="export-modal__copy-btn">copy json</button>
            </>
          ) : (
            <>
              <label className="export-modal__label">paste exported json</label>
              <textarea
                className="export-modal__textarea"
                placeholder='{"servers":[...]}'
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <button onClick={handleImport} className="export-modal__import-btn" disabled={!importText.trim()}>
                import
              </button>
            </>
          )}

          {status && (
            <p className={`export-modal__status ${statusIsError ? 'export-modal__status--err' : 'export-modal__status--ok'}`}>
              {status}
            </p>
          )}
        </div>

        <div className="export-modal__footer">
          <button onClick={handleClose} className="export-modal__done-btn">close</button>
        </div>
      </div>
    </div>
  )
}
