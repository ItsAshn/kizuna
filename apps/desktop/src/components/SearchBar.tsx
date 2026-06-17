import { useState, useRef, useEffect } from 'react'
import { searchMessages } from '@kizuna/shared'
import { useServerStore } from '../store/serverStore'
import { X, Search, Loader2 } from 'lucide-react'
import type { Message } from '@kizuna/shared'
import '../styles/search.css'

interface SearchBarProps {
  channelId: string
  onClose: () => void
  onJumpToMessage: (messageId: string, channelId: string) => void
}

export default function SearchBar({ channelId, onClose, onJumpToMessage }: SearchBarProps) {
  const session = useServerStore((s) => s.activeSession)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ message: Message; channelName: string }[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query.trim() || query.length < 2) {
      setResults([])
      setHasMore(false)
      return
    }

    const timer = setTimeout(async () => {
      if (!session) return
      setLoading(true)
      try {
        const { results: r, hasMore: hm } = await searchMessages(session.url, query, channelId)
        setResults(r)
        setHasMore(hm)
      } catch {}
      setLoading(false)
    }, 300)

    return () => clearTimeout(timer)
  }, [query, channelId, session])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="search-bar">
      <div className="search-bar__input-wrap">
        <Search size={14} className="search-bar__input-icon" />
        <input
          ref={inputRef}
          type="text"
          className="search-bar__input"
          placeholder="Search messages..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search messages"
        />
        {loading && <Loader2 size={14} className="search-bar__spinner" />}
        <button className="search-bar__close" onClick={onClose} aria-label="Close search">
          <X size={14} />
        </button>
      </div>
      {query.length >= 2 && results.length > 0 && (
        <div className="search-bar__results">
          {results.map((r) => (
            <button
              key={r.message.id}
              className="search-bar__result"
              onClick={() => onJumpToMessage(r.message.id, r.message.channel_id)}
            >
              <span className="search-bar__result-user">@{r.message.display_name || r.message.username}</span>
              <span className="search-bar__result-content">{r.message.content}</span>
              <span className="search-bar__result-time">
                {new Date(r.message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </button>
          ))}
          {hasMore && <div className="search-bar__more">More results available — refine your search</div>}
        </div>
      )}
      {query.length >= 2 && !loading && results.length === 0 && (
        <div className="search-bar__empty">No results found</div>
      )}
    </div>
  )
}
