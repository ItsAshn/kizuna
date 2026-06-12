import { useState, useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'
import { fetchPopularReactions } from '@kizuna/shared'

interface ReactionBarProps {
  serverUrl: string
  token: string
  onReact: (reactionKey: string, reactionType: string) => void
  onAddClick: () => void
  visible: boolean
}

export default function ReactionBar({ serverUrl, token, onReact, onAddClick, visible }: ReactionBarProps) {
  const [quickEmojis, setQuickEmojis] = useState<string[]>(['👍', '❤️', '😆', '😮', '😢'])
  const [quickStickers, setQuickStickers] = useState<{ id: string; url: string }[]>([])
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchPopularReactions(serverUrl, token)
      .then(data => {
        if (data.emojis?.length) setQuickEmojis(data.emojis.slice(0, 5))
        if (data.stickers?.length) setQuickStickers(data.stickers.slice(0, 3))
      })
      .catch(() => {})
  }, [serverUrl, token])

  const handleQuickReact = (key: string, type: string = 'emoji') => {
    onReact(key, type)
  }

  return (
    <div className={`msg-bubble__react-bar ${visible ? 'msg-bubble__react-bar--visible' : ''}`} ref={barRef}>
      <div className="msg-bubble__react-bar-inner">
        {quickEmojis.map((emoji) => (
          <button
            key={emoji}
            className="msg-bubble__react-quick"
            onClick={(e) => { e.stopPropagation(); handleQuickReact(emoji, 'emoji') }}
            title={emoji}
          >
            {emoji}
          </button>
        ))}
        {quickStickers.map((s) => (
          <button
            key={s.id}
            className="msg-bubble__react-quick"
            onClick={(e) => { e.stopPropagation(); handleQuickReact(s.id, 'sticker') }}
            title="sticker"
          >
            <img src={serverUrl + s.url} alt="" className="msg-bubble__react-quick-sticker" />
          </button>
        ))}
        <button
          className="msg-bubble__react-quick msg-bubble__react-quick--add"
          onClick={(e) => { e.stopPropagation(); onAddClick() }}
          title="Add reaction"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}
