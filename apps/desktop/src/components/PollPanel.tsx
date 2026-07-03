import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { X, ChevronDown, ChevronUp, BarChart3 } from 'lucide-react'
import type { PollData } from '@kizuna/shared'
import { votePoll, fetchPoll } from '@kizuna/shared'
import { useChatStore } from '../store/chatStore'
import './PollPanel.css'

const EMPTY_POLLS: PollData[] = []

interface PollPanelProps {
  serverUrl: string
  channelId: string | null
  isOpen: boolean
  onClose: () => void
}

export default function PollPanel({ serverUrl, channelId, isOpen, onClose }: PollPanelProps) {
  const polls = useChatStore(
    (s) => (channelId ? s.polls[channelId] : undefined) ?? EMPTY_POLLS,
  )

  const sortedPolls = useMemo(() => {
    return [...polls].sort((a, b) => b.createdAt - a.createdAt)
  }, [polls])

  const [expandedHistory, setExpandedHistory] = useState(false)
  const [userVoteIdsByPoll, setUserVoteIdsByPoll] = useState<Map<string, string[]>>(new Map())
  const [loadingPollId, setLoadingPollId] = useState<string | null>(null)
  const fetchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    sortedPolls.forEach((p) => {
      if (!fetchedRef.current.has(p.pollId) && serverUrl) {
        fetchedRef.current.add(p.pollId)
        fetchPoll(serverUrl, p.pollId).then((res) => {
          setUserVoteIdsByPoll((prev) => {
            const next = new Map(prev)
            next.set(p.pollId, res.poll.userVoteIds)
            return next
          })
        }).catch(() => {})
      }
    })
  }, [sortedPolls, serverUrl])

  const handleVote = useCallback(async (pollId: string, optionId: string) => {
    if (loadingPollId || !serverUrl) return
    setLoadingPollId(pollId)
    try {
      const res = await votePoll(serverUrl, pollId, optionId)
      setUserVoteIdsByPoll((prev) => {
        const next = new Map(prev)
        next.set(pollId, res.userVoteIds)
        return next
      })
    } catch { /* ignore */ }
    finally { setLoadingPollId(null) }
  }, [loadingPollId, serverUrl])

  if (!isOpen || sortedPolls.length === 0) return null

  const renderPoll = (poll: PollData, isCompact: boolean) => {
    const options = poll.options
    const votedIds = userVoteIdsByPoll.get(poll.pollId) ?? []
    const totalVotes = options.reduce((s, o) => s + (o.vote_count ?? 0), 0)

    return (
      <div key={poll.pollId} className={`poll-panel__card${isCompact ? ' poll-panel__card--compact' : ''}`}>
        <div className="poll-panel__question">{poll.question}</div>
        <div className="poll-panel__options">
          {options.map((opt) => {
            const pct = totalVotes > 0 ? Math.round(((opt.vote_count ?? 0) / totalVotes) * 100) : 0
            const voted = votedIds.includes(opt.id)
            return (
              <button
                key={opt.id}
                className={`poll-panel__option${voted ? ' poll-panel__option--voted' : ''}`}
                onClick={() => handleVote(poll.pollId, opt.id)}
                disabled={loadingPollId === poll.pollId}
                aria-label={`Vote for ${opt.label} (${opt.vote_count ?? 0} votes)`}
              >
                <div className="poll-panel__bar" style={{ width: `${pct}%` }} />
                <span className="poll-panel__label">{opt.label}</span>
                <span className="poll-panel__pct">{pct}%</span>
              </button>
            )
          })}
        </div>
        <div className="poll-panel__footer">{totalVotes} vote{totalVotes !== 1 ? 's' : ''}</div>
      </div>
    )
  }

  const latestPoll = sortedPolls[0] ?? null

  return (
    <div className="poll-panel">
      <div className="poll-panel__header">
        <BarChart3 size={14} />
        <span className="poll-panel__title">Polls</span>
        <span className="poll-panel__count">{sortedPolls.length}</span>
        <div className="poll-panel__header-actions">
          {sortedPolls.length > 1 && (
            <button
              className="poll-panel__history-btn"
              onClick={() => setExpandedHistory((v) => !v)}
              aria-label={expandedHistory ? 'Collapse poll history' : 'Expand poll history'}
            >
              {expandedHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span className="poll-panel__history-label">History</span>
            </button>
          )}
          <button className="poll-panel__close-btn" onClick={onClose} aria-label="Close polls">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="poll-panel__body">
        {latestPoll && renderPoll(latestPoll, false)}
        {expandedHistory && sortedPolls.length > 1 && (
          <div className="poll-panel__history">
            <div className="poll-panel__history-divider">Previous Polls</div>
            {sortedPolls.slice(1).map((p) => renderPoll(p, true))}
          </div>
        )}
      </div>
    </div>
  )
}
