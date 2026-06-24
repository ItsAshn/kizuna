import { useState } from 'react'
import { useServerStore } from '../store/serverStore'
import Modal from './ui/Modal'
import './ExportModal.css'

interface Props {
  onClose: () => void
}

export default function ExportModal({ onClose }: Props) {
  const { servers } = useServerStore()
  const [importText, setImportText] = useState('')
  const [status, setStatus] = useState('')
  const [statusIsError, setStatusIsError] = useState(false)

  const jsonData = JSON.stringify({ servers })

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
    <Modal
      open
      onClose={onClose}
      title="// data"
      className="export-modal"
      footer={(handleClose) => <button onClick={handleClose} className="btn-secondary export-modal__done-btn">close</button>}
    >
      <label className="export-modal__label">exported json</label>
      <pre className="export-modal__json">{jsonData}</pre>
      <button onClick={handleCopy} className="export-modal__copy-btn">copy json</button>

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

      {status && (
        <p className={`export-modal__status ${statusIsError ? 'export-modal__status--err' : 'export-modal__status--ok'}`}>
          {status}
        </p>
      )}
    </Modal>
  )
}
