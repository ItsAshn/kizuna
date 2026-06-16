import { Phone, PhoneOff } from 'lucide-react'
import type { DMIncomingCall } from '../store/chatStore'
import '../styles/incoming-call.css'

interface IncomingCallModalProps {
  incomingCall: DMIncomingCall
  onAccept: () => void
  onReject: () => void
}

export default function IncomingCallModal({ incomingCall, onAccept, onReject }: IncomingCallModalProps) {
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
            onClick={onAccept}
            className="incoming-call-btn incoming-call-btn--accept"
            title="Accept call"
          >
            <Phone className="icon-md" />
          </button>
          <button
            onClick={onReject}
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
