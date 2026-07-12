import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { fetchGifs, fetchStickerPacks } from '@kizuna/shared'
import type { GifInfo } from '@kizuna/shared'
import IconButton from './ui/IconButton'
import PickerSurface from './ui/PickerSurface'
import { useMobile } from '../hooks/useMobile'

interface ReactionPickerProps {
  serverUrl: string
  onSelect: (key: string, type: 'emoji' | 'sticker') => void
  onClose: () => void
}

const EMOJI_GRID = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂',
  '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😋',
  '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😒',
  '😮', '😯', '😲', '😳', '🥺', '😢', '😭', '😱',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '👏', '🙌',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
  '🔥', '⭐', '🎉', '✨', '💯', '✅', '❌', '💀',
  '🤡', '🙈', '🐐', '🚀', '🎯', '💪', '🙏', '👀',
]

type Tab = 'emoji' | 'sticker'

export default function ReactionPicker({ serverUrl, onSelect, onClose }: ReactionPickerProps) {
  const isMobile = useMobile()
  const [tab, setTab] = useState<Tab>('emoji')
  const [stickers, setStickers] = useState<GifInfo[]>([])
  const [stickerPacks, setStickerPacks] = useState<string[]>([])
  const [activePack, setActivePack] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (tab === 'sticker') {
      setLoading(true)
      fetchStickerPacks(serverUrl).then(packs => {
        setStickerPacks(packs)
        if (packs.length > 0 && !activePack) setActivePack(packs[0])
      }).catch(() => {}).finally(() => setLoading(false))
    }
  }, [tab, serverUrl])

  useEffect(() => {
    if (tab === 'sticker' && activePack) {
      setLoading(true)
      fetchGifs(serverUrl, { type: 'sticker', pack: activePack, limit: 50 })
        .then(setStickers)
        .catch(() => setStickers([]))
        .finally(() => setLoading(false))
    }
  }, [tab, activePack, serverUrl])

  return (
    <PickerSurface base="reaction-picker" isMobile={isMobile} onClose={onClose}>
        <div className="reaction-picker__header">
          <div className="reaction-picker__tabs">
            <button
              className={`reaction-picker__tab ${tab === 'emoji' ? 'reaction-picker__tab--active' : ''}`}
              onClick={() => setTab('emoji')}
            >
              Emojis
            </button>
            <button
              className={`reaction-picker__tab ${tab === 'sticker' ? 'reaction-picker__tab--active' : ''}`}
              onClick={() => setTab('sticker')}
            >
              Stickers
            </button>
          </div>
          <IconButton size="sm" icon={<X size={16} />} label="Close" onClick={onClose} />
        </div>

        {tab === 'emoji' && (
          <div className="reaction-picker__emoji-grid">
            {EMOJI_GRID.map(emoji => (
              <button
                key={emoji}
                className="reaction-picker__emoji-btn"
                onClick={() => onSelect(emoji, 'emoji')}
                title={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {tab === 'sticker' && (
          <>
            {stickerPacks.length > 0 && (
              <div className="reaction-picker__packs">
                {stickerPacks.map(pack => (
                  <button
                    key={pack}
                    className={`reaction-picker__pack-btn ${activePack === pack ? 'reaction-picker__pack-btn--active' : ''}`}
                    onClick={() => setActivePack(pack)}
                  >
                    {pack}
                  </button>
                ))}
              </div>
            )}
            <div className="reaction-picker__sticker-grid">
              {loading && <div className="reaction-picker__status">Loading...</div>}
              {!loading && stickers.length === 0 && (
                <div className="reaction-picker__status">No stickers in this pack</div>
              )}
              {!loading && stickers.map(s => {
                const url = s.file_url.startsWith('/') ? `${serverUrl}${s.file_url}` : s.file_url
                return (
                  <button
                    key={s.id}
                    className="reaction-picker__sticker-btn"
                    onClick={() => onSelect(s.id, 'sticker')}
                    title={s.display_name}
                  >
                    <img src={url} alt={s.display_name} className="reaction-picker__sticker-img" loading="lazy" />
                  </button>
                )
              })}
            </div>
          </>
        )}
    </PickerSurface>
  )
}
