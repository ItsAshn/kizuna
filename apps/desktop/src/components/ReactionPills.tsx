import type { MessageReaction } from '@kizuna/shared'
import { useServerStore } from '../store/serverStore'

interface ReactionPillsProps {
  reactions: MessageReaction[]
  currentUserId?: string
  serverUrl?: string
  onToggle: (reactionKey: string, reactionType: string) => void
}

export default function ReactionPills({ reactions, currentUserId, serverUrl, onToggle }: ReactionPillsProps) {
  if (!reactions.length) return null

  return (
    <div className="msg-bubble__reactions">
      {reactions.map((r) => {
        const isSticker = r.reaction_type === 'sticker'
        const hasReacted = currentUserId ? r.users.some(u => u.user_id === currentUserId) : false
        const tooltip = r.users.map(u => u.username).join(', ')
        const stickerUrl = isSticker && serverUrl
          ? `${serverUrl}/api/gifs/${r.reaction_key}/file`
          : null

        return (
          <button
            key={r.reaction_key}
            className={`msg-bubble__reaction ${hasReacted ? 'msg-bubble__reaction--active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggle(r.reaction_key, r.reaction_type) }}
            title={tooltip}
          >
            {isSticker && stickerUrl ? (
              <img src={stickerUrl} alt="" className="msg-bubble__reaction-sticker" />
            ) : (
              <span className="msg-bubble__reaction-emoji">{r.reaction_key}</span>
            )}
            <span className="msg-bubble__reaction-count">{r.count}</span>
          </button>
        )
      })}
    </div>
  )
}
