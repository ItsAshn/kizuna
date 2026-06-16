import { useEffect } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import type { DMIncomingCall } from '../store/chatStore'
import '../styles/incoming-call.css'

interface IncomingCallModalProps {
  incomingCall: DMIncomingCall
  onAccept: () => void
  onReject: () => void
}

function playRingtone(ctx: AudioContext, dest: AudioNode) {
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = 440
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.3, now + 0.05)
  gain.gain.setValueAtTime(0.3, now + 0.4)
  gain.gain.linearRampToValueAtTime(0, now + 0.5)
  gain.gain.setValueAtTime(0, now + 1.0)
  gain.gain.setValueAtTime(0.3, now + 1.05)
  gain.gain.linearRampToValueAtTime(0.3, now + 1.4)
  gain.gain.linearRampToValueAtTime(0, now + 1.5)
  gain.gain.setValueAtTime(0, now + 2.0)
  osc.connect(gain).connect(dest)
  osc.start(now)
  osc.stop(now + 2)

  const osc2 = ctx.createOscillator()
  const gain2 = ctx.createGain()
  osc2.type = 'sine'
  osc2.frequency.value = 523
  gain2.gain.setValueAtTime(0, now)
  gain2.gain.linearRampToValueAtTime(0.3, now + 0.05)
  gain2.gain.setValueAtTime(0.3, now + 0.4)
  gain2.gain.linearRampToValueAtTime(0, now + 0.5)
  gain2.gain.setValueAtTime(0, now + 1.0)
  gain2.gain.setValueAtTime(0.3, now + 1.05)
  gain2.gain.linearRampToValueAtTime(0.3, now + 1.4)
  gain2.gain.linearRampToValueAtTime(0, now + 1.5)
  gain2.gain.setValueAtTime(0, now + 2.0)
  osc2.connect(gain2).connect(dest)
  osc2.start(now)
  osc2.stop(now + 2)
}

export default function IncomingCallModal({ incomingCall, onAccept, onReject }: IncomingCallModalProps) {
  useEffect(() => {
    const ctx = new AudioContext()
    const dest = ctx.createGain()
    dest.gain.value = 0.15
    dest.connect(ctx.destination)
    playRingtone(ctx, dest)
    const interval = window.setInterval(() => playRingtone(ctx, dest), 3000)
    return () => {
      clearInterval(interval)
      ctx.close()
    }
  }, [])

  const handleAccept = () => {
    onAccept()
  }

  const handleReject = () => {
    onReject()
  }

  return (
    <div className="incoming-call-overlay">
      <div className="incoming-call-card">
        <div className="incoming-call-avatar">
          {incomingCall.callerUsername[0]?.toUpperCase()}
        </div>
        <h2 className="incoming-call-title">{incomingCall.callerUsername}</h2>
        <p className="incoming-call-subtitle">Incoming Call</p>
        <div className="incoming-call-actions">
          <button
            onClick={handleAccept}
            className="incoming-call-btn incoming-call-btn--accept"
            title="Accept call"
          >
            <Phone className="icon-md" />
          </button>
          <button
            onClick={handleReject}
            className="incoming-call-btn incoming-call-btn--reject"
            title="Decline call"
          >
            <PhoneOff className="icon-md" />
          </button>
        </div>
      </div>
    </div>
  )
}
