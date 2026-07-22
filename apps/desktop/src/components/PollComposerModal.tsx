import { useState, useCallback } from 'react'
import { Plus, X } from 'lucide-react'
import { createPoll, createDMPoll, createGroupDMPoll } from '@kizuna/shared'
import Modal from './ui/Modal'
import Button from './ui/Button'
import Input from './ui/Input'
import Checkbox from './ui/Checkbox'
import './PollComposerModal.css'

const MAX_OPTIONS = 10

type ChannelType = 'channel' | 'dm' | 'group-dm'

interface DurationPreset {
  label: string
  seconds: number | null
}

const DURATIONS: DurationPreset[] = [
  { label: 'No end', seconds: null },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '6 hours', seconds: 60 * 60 * 6 },
  { label: '1 day', seconds: 60 * 60 * 24 },
  { label: '3 days', seconds: 60 * 60 * 24 * 3 },
  { label: '1 week', seconds: 60 * 60 * 24 * 7 },
]

interface PollComposerModalProps {
  open: boolean
  onClose: () => void
  serverUrl: string
  channelId: string | null
  channelType: ChannelType
}

export default function PollComposerModal({
  open,
  onClose,
  serverUrl,
  channelId,
  channelType,
}: PollComposerModalProps) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [durationIndex, setDurationIndex] = useState(0)
  const [allowMultiple, setAllowMultiple] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setQuestion('')
    setOptions(['', ''])
    setDurationIndex(0)
    setAllowMultiple(false)
    setError(null)
    setSubmitting(false)
  }, [])

  const handleClose = useCallback(() => {
    reset()
    onClose()
  }, [reset, onClose])

  const setOption = (i: number, value: string) => {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)))
  }

  const addOption = () => {
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, '']))
  }

  const removeOption = (i: number) => {
    setOptions((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)))
  }

  const handleSubmit = useCallback(async () => {
    if (submitting || !channelId) return
    const q = question.trim()
    const opts = options.map((o) => o.trim()).filter(Boolean)
    if (!q) {
      setError('Add a question')
      return
    }
    if (opts.length < 2) {
      setError('Add at least 2 options')
      return
    }

    const durationSeconds = DURATIONS[durationIndex]?.seconds ?? null
    setSubmitting(true)
    setError(null)
    try {
      const createOpts = { durationSeconds, allowMultiple }
      if (channelType === 'dm') {
        await createDMPoll(serverUrl, channelId, q, opts, createOpts)
      } else if (channelType === 'group-dm') {
        await createGroupDMPoll(serverUrl, channelId, q, opts, createOpts)
      } else {
        await createPoll(serverUrl, channelId, q, opts, createOpts)
      }
      handleClose()
    } catch (err: unknown) {
      setError(
        (err as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error ??
          'Failed to create poll',
      )
      setSubmitting(false)
    }
  }, [submitting, channelId, question, options, durationIndex, allowMultiple, channelType, serverUrl, handleClose])

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Create poll"
      className="poll-composer"
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={submitting}>
            Create poll
          </Button>
        </>
      }
    >
      <div className="poll-composer__body">
        <Input
          label="Question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What should we play tonight?"
          maxLength={300}
        />

        <div className="poll-composer__field">
          <span className="poll-composer__label">Options</span>
          <div className="poll-composer__options">
            {options.map((opt, i) => (
              <div className="poll-composer__option-row" key={i}>
                <Input
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value)}
                  placeholder={`Option ${i + 1}`}
                  maxLength={100}
                  className="poll-composer__option-input"
                />
                <button
                  type="button"
                  className="poll-composer__remove-btn"
                  onClick={() => removeOption(i)}
                  disabled={options.length <= 2}
                  aria-label={`Remove option ${i + 1}`}
                  title="Remove option"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          {options.length < MAX_OPTIONS && (
            <button type="button" className="poll-composer__add-btn" onClick={addOption}>
              <Plus size={14} />
              Add option
            </button>
          )}
        </div>

        <div className="poll-composer__field">
          <label className="poll-composer__label" htmlFor="poll-duration">
            Ends in
          </label>
          <select
            id="poll-duration"
            className="poll-composer__select"
            value={durationIndex}
            onChange={(e) => setDurationIndex(Number(e.target.value))}
          >
            {DURATIONS.map((d, i) => (
              <option key={d.label} value={i}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <Checkbox
          checked={allowMultiple}
          onChange={setAllowMultiple}
          label="Allow selecting multiple options"
        />

        {error && <div className="poll-composer__error">{error}</div>}
      </div>
    </Modal>
  )
}
