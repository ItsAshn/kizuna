import { useState, useEffect } from 'react'
import { Check, Copy, CheckCheck } from 'lucide-react'
import './BackupTokenModal.css'

interface Props {
  backuptoken: string
  onComplete: () => void
}

export default function BackupTokenModal({ backuptoken, onComplete }: Props) {
  const [step, setStep] = useState<'display' | 'confirm' | 'agree'>('display')
  const [confirmInput, setConfirmInput] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [copied, setCopied] = useState(false)

  const confirmed = confirmInput.trim() === backuptoken

  function handleCopy() {
    navigator.clipboard.writeText(backuptoken)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && step === 'display') {
        onComplete()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [step, onComplete])

  return (
    <div className="backuptoken-overlay">
      <div className="backuptoken-modal">
        <h2 className="backuptoken-modal__title">Save Your Backup Token</h2>

        {step === 'display' && (
          <>
            <div className="backuptoken-modal__warning">
              <p>This backup token is the <strong>only way</strong> to recover your account if you forget your password.</p>
            </div>

            <div className="backuptoken-modal__token-box">
              <code className="backuptoken-modal__token">{backuptoken}</code>
              <button onClick={handleCopy} className="backuptoken-modal__copy-btn" aria-label="Copy backup token">
                {copied ? <CheckCheck size={16} /> : <Copy size={16} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="backuptoken-modal__warning">
              <p>Copy this token <strong>now</strong>. You will not be able to see it again.</p>
            </div>

            <p className="backuptoken-modal__hint">
              Store it in a password manager, write it down, or save it somewhere safe.
            </p>

            <button className="btn-primary" style={{ width: '100%', marginTop: '12px' }} onClick={() => setStep('confirm')}>
              I Have Copied It
            </button>
          </>
        )}

        {step === 'confirm' && (
          <>
            <div className="backuptoken-modal__warning">
              <p>Paste or type your backup token below to confirm you have saved it:</p>
            </div>

            <input
              className="input-field backuptoken-modal__confirm-input"
              placeholder="Paste your backup token here..."
              autoFocus
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
            />

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button className="btn-secondary" onClick={() => { setConfirmInput(''); setStep('display') }}>
                Back
              </button>
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={!confirmed}
                onClick={() => setStep('agree')}
              >
                {confirmed ? <Check size={16} /> : null}
                Confirm
              </button>
            </div>
          </>
        )}

        {step === 'agree' && (
          <>
            <div className="backuptoken-modal__warning backuptoken-modal__warning--danger">
              <p>If you lose this backup token and no admin is available, <strong>your account cannot be recovered</strong>.</p>
            </div>

            <p className="backuptoken-modal__hint">
              There is no way to recover your account without this token unless a server admin helps you.
            </p>

            <label className="backuptoken-modal__checkbox">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>I understand. I have saved my backup token and accept that losing it may result in permanent loss of access.</span>
            </label>

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button className="btn-secondary" onClick={() => setStep('confirm')}>
                Back
              </button>
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={!agreed}
                onClick={onComplete}
              >
                I Have Saved My Backup Token
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
