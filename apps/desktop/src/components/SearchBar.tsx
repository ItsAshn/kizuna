import { useState, useRef, useEffect, useCallback } from 'react'
import { searchMessages } from '@kizuna/shared'
import { useServerStore } from '../store/serverStore'
import { X, Search, Loader2, ChevronDown } from 'lucide-react'
import type { Message } from '@kizuna/shared'
import './SearchBar.css'

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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastQueryRef = useRef('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const doSearch = useCallback(async (q: string, before?: string) => {
    if (!session) return
    const isNewSearch = !before
    if (isNewSearch) {
      setLoading(true)
      setResults([])
    } else {
      setLoadingMore(true)
    }
    lastQueryRef.current = q
    try {
      const { results: r, hasMore: hm } = await searchMessages(session.url, q, channelId, 20, before)
      if (lastQueryRef.current !== q) return
      if (isNewSearch) {
        setResults(r)
      } else {
        setResults(prev => [...prev, ...r])
      }
      setHasMore(hm)
    } catch {}
    setLoading(false)
    setLoadingMore(false)
  }, [session, channelId])

  useEffect(() => {
    if (!query.trim() || query.length < 2) {
      setResults([])
      setHasMore(false)
      return
    }

    const timer = setTimeout(() => {
      doSearch(query)
    }, 300)

    return () => clearTimeout(timer)
  }, [query, doSearch])

  function handleLoadMore() {
    if (!hasMore || loadingMore || results.length === 0) return
    const lastResult = results[results.length - 1]!
    doSearch(query, lastResult.message.id)
  }

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
          {hasMore && (
            <button className="search-bar__load-more" onClick={handleLoadMore} disabled={loadingMore}>
              {loadingMore ? <Loader2 size={12} className="search-bar__spinner" /> : <ChevronDown size={14} />}
              {loadingMore ? 'Loading...' : 'Load more results'}
            </button>
          )}
        </div>
      )}
      {query.length >= 2 && !loading && results.length === 0 && (
        <div className="search-bar__empty">No results found</div>
      )}
    </div>
  )
}
