import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { X, ChevronDown, ChevronUp, BarChart3, Trash2, Plus, Clock } from 'lucide-react'
import type { PollData } from '@kizuna/shared'
import { votePoll, fetchPoll, deletePoll } from '@kizuna/shared'
import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import { useNotificationStore } from '../store/notificationStore'
import './PollPanel.css'

const EMPTY_POLLS: PollData[] = []

/** Human-readable time remaining until `closesAt` (epoch ms), or a "closed" flag. */
function describeCloses(closesAt: number | null, now: number): { closed: boolean; text: string } | null {
  if (!closesAt) return null
  const diff = closesAt - now
  if (diff <= 0) return { closed: true, text: 'Poll closed' }
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return { closed: false, text: `Ends in ${Math.max(1, mins)}m` }
  const hours = Math.floor(mins / 60)
  if (hours < 24) return { closed: false, text: `Ends in ${hours}h ${mins % 60}m` }
  const days = Math.floor(hours / 24)
  return { closed: false, text: `Ends in ${days}d ${hours % 24}h` }
}

interface PollPanelProps {
  serverUrl: string
  channelId: string | null
  isOpen: boolean
  onClose: () => void
  onCreatePoll?: () => void
}

export default function PollPanel({ serverUrl, channelId, isOpen, onClose, onCreatePoll }: PollPanelProps) {
  const session = useServerStore((s) => s.activeSession)
  const polls = useChatStore(
    (s) => (channelId ? s.polls[channelId] : undefined) ?? EMPTY_POLLS,
  )
  const removePoll = useChatStore((s) => s.removePoll)

  const sortedPolls = useMemo(() => {
    return [...polls].sort((a, b) => b.createdAt - a.createdAt)
  }, [polls])

  const [expandedHistory, setExpandedHistory] = useState(false)
  const [userVoteIdsByPoll, setUserVoteIdsByPoll] = useState<Map<string, string[]>>(new Map())
  const [loadingPollId, setLoadingPollId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const fetchedRef = useRef<Set<string>>(new Set())

  const currentUserId = session?.user.id ?? ''
  const isAdmin = session?.user.role === 'admin'

  // Tick every 30s so countdowns update and polls flip to "closed" on time.
  const hasCountdown = sortedPolls.some((p) => p.closesAt)
  useEffect(() => {
    if (!isOpen || !hasCountdown) return
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [isOpen, hasCountdown])

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

  const handleDelete = useCallback(async (pollId: string) => {
    if (!serverUrl || !channelId) return
    try {
      await deletePoll(serverUrl, pollId)
      removePoll(channelId, pollId)
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to delete poll'
      useNotificationStore.getState().addNotification({ type: 'announce', title: 'Poll', body: message })
    }
  }, [serverUrl, channelId, removePoll])

  if (!isOpen || sortedPolls.length === 0) return null

  const canDelete = (poll: PollData) => isAdmin || poll.createdBy === currentUserId

  const renderPoll = (poll: PollData, isCompact: boolean) => {
    const options = poll.options
    const votedIds = userVoteIdsByPoll.get(poll.pollId) ?? []
    const totalVotes = options.reduce((s, o) => s + (o.vote_count ?? 0), 0)
    const closesInfo = describeCloses(poll.closesAt, now)
    const isClosed = closesInfo?.closed ?? false

    return (
      <div key={poll.pollId} className={`poll-panel__card${isCompact ? ' poll-panel__card--compact' : ''}`}>
        <div className="poll-panel__card-header">
          <div className="poll-panel__question">{poll.question}</div>
          {canDelete(poll) && (
            <button
              className="poll-panel__delete-btn"
              onClick={() => handleDelete(poll.pollId)}
              aria-label="Delete poll"
              title="Delete poll"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="poll-panel__options">
          {options.map((opt) => {
            const pct = totalVotes > 0 ? Math.round(((opt.vote_count ?? 0) / totalVotes) * 100) : 0
            const voted = votedIds.includes(opt.id)
            return (
              <button
                key={opt.id}
                className={`poll-panel__option${voted ? ' poll-panel__option--voted' : ''}`}
                onClick={() => handleVote(poll.pollId, opt.id)}
                disabled={loadingPollId === poll.pollId || isClosed}
                aria-label={`Vote for ${opt.label} (${opt.vote_count ?? 0} votes)`}
              >
                <div className="poll-panel__bar" style={{ width: `${pct}%` }} />
                <span className="poll-panel__label">{opt.label}</span>
                <span className="poll-panel__pct">{pct}%</span>
              </button>
            )
          })}
        </div>
        <div className="poll-panel__footer">
          <span>
            {totalVotes} vote{totalVotes !== 1 ? 's' : ''}
            {poll.allowMultiple ? ' · multiple choice' : ''}
          </span>
          {closesInfo && (
            <span className={`poll-panel__closes${isClosed ? ' poll-panel__closes--closed' : ''}`}>
              <Clock size={11} />
              {closesInfo.text}
            </span>
          )}
        </div>
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
          {onCreatePoll && (
            <button
              className="poll-panel__history-btn"
              onClick={onCreatePoll}
              aria-label="Create a new poll"
            >
              <Plus size={14} />
              <span className="poll-panel__history-label">New</span>
            </button>
          )}
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
