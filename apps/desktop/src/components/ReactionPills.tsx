import { useState } from 'react'
import type { MessageReaction } from '@kizuna/shared'

const MAX_VISIBLE = 6

interface ReactionPillsProps {
  reactions: MessageReaction[]
  currentUserId?: string
  serverUrl?: string
  onToggle: (reactionKey: string, reactionType: string) => void
}

function ReactionPill({ reaction, currentUserId, serverUrl, onToggle }: {
  reaction: MessageReaction
  currentUserId?: string
  serverUrl?: string
  onToggle: (key: string, type: string) => void
}) {
  const isSticker = reaction.reaction_type === 'sticker'
  const hasReacted = currentUserId ? reaction.users.some(u => u.user_id === currentUserId) : false
  const tooltip = reaction.users.map(u => u.username).join(', ')
  const stickerUrl = isSticker && serverUrl
    ? `${serverUrl}/api/gifs/${reaction.reaction_key}/file`
    : null

  return (
    <button
      key={reaction.reaction_key}
      className={`msg-bubble__reaction ${hasReacted ? 'msg-bubble__reaction--active' : ''}`}
      onClick={(e) => { e.stopPropagation(); onToggle(reaction.reaction_key, reaction.reaction_type) }}
      title={tooltip}
    >
      {isSticker && stickerUrl ? (
        <img src={stickerUrl} alt="" className="msg-bubble__reaction-sticker" />
      ) : (
        <span className="msg-bubble__reaction-emoji">{reaction.reaction_key}</span>
      )}
      <span className="msg-bubble__reaction-count">{reaction.count}</span>
    </button>
  )
}

export default function ReactionPills({ reactions, currentUserId, serverUrl, onToggle }: ReactionPillsProps) {
  const [expanded, setExpanded] = useState(false)

  if (!reactions.length) return null

  const overflows = reactions.length > MAX_VISIBLE
  const visibleReactions = overflows && !expanded ? reactions.slice(0, MAX_VISIBLE - 1) : reactions
  const hiddenCount = reactions.length - (MAX_VISIBLE - 1)

  return (
    <div className="msg-bubble__reactions">
      {visibleReactions.map((r) => (
        <ReactionPill
          key={r.reaction_key}
          reaction={r}
          currentUserId={currentUserId}
          serverUrl={serverUrl}
          onToggle={onToggle}
        />
      ))}
      {overflows && (
        <button
          className={`msg-bubble__reaction msg-bubble__reaction--overflow ${expanded ? 'msg-bubble__reaction--overflow-expanded' : ''}`}
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
          title={expanded ? 'Show less' : `${hiddenCount} more reactions`}
        >
          <span className="msg-bubble__reaction-emoji">
            {expanded ? '−' : `+${hiddenCount}`}
          </span>
        </button>
      )}
    </div>
  )
}
