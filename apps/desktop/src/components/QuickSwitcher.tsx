import { useState, useRef, useEffect, useMemo } from 'react'
import { useChatStore } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'
import { Hash, Volume2, AtSign, Clock } from 'lucide-react'
import './QuickSwitcher.css'

interface QuickSwitcherProps {
  onClose: () => void
}

interface SwitchItem {
  id: string
  type: 'text' | 'voice' | 'dm'
  name: string
  subtitle: string
  score: number
  isRecent: boolean
}

function fuzzyMatch(query: string, target: string): number {
  let qi = 0
  let score = 0
  let consecutive = 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++
      consecutive++
      score += consecutive * 2
    } else {
      consecutive = 0
    }
  }

  if (qi < q.length) return 0
  return score
}

export default function QuickSwitcher({ onClose }: QuickSwitcherProps) {
  const { channels, dmChannels, setActiveChannel, setActiveDMChannel } = useChatStore()
  const recentChannels = useSettingsStore((s) => s.recentChannels ?? [])
  const pushRecent = useSettingsStore((s) => s.pushRecentChannel)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const results = useMemo(() => {
    const q = query.toLowerCase().trim()
    const items: SwitchItem[] = []

    for (const ch of channels) {
      const score = q ? fuzzyMatch(q, ch.name) : 0
      if (q && score === 0 && !ch.name.toLowerCase().includes(q)) continue
      const isRecent = recentChannels.some((r) => r.id === ch.id && r.type === ch.type)
      items.push({
        id: ch.id,
        type: ch.type,
        name: ch.name,
        subtitle: ch.type === 'voice' ? 'Voice Channel' : 'Text Channel',
        score: q ? score : (isRecent ? 100 : 0),
        isRecent,
      })
    }

    for (const dm of dmChannels) {
      const name = dm.other_display_name || dm.other_username
      const score = q ? Math.max(fuzzyMatch(q, name), fuzzyMatch(q, dm.other_username)) : 0
      if (q && score === 0 && !name.toLowerCase().includes(q) && !dm.other_username.toLowerCase().includes(q)) continue
      const isRecent = recentChannels.some((r) => r.id === dm.id && r.type === 'dm')
      items.push({
        id: dm.id,
        type: 'dm',
        name,
        subtitle: `@${dm.other_username}`,
        score: q ? score : (isRecent ? 50 : 0),
        isRecent,
      })
    }

    items.sort((a, b) => {
      if (q) return b.score - a.score
      return b.score - a.score
    })

    return items
  }, [query, channels, dmChannels, recentChannels])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSelect(item: SwitchItem) {
    pushRecent({ id: item.id, type: item.type })
    if (item.type === 'dm') {
      setActiveDMChannel(item.id)
    } else if (item.type === 'voice') {
      setActiveChannel(item.id)
    } else {
      setActiveChannel(item.id)
    }
    onClose()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (i + 1) % Math.max(results.length, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[selectedIndex]) {
        handleSelect(results[selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="quick-switcher-overlay" onClick={onClose}>
      <div className="quick-switcher" onClick={(e) => e.stopPropagation()}>
        <div className="quick-switcher__input-wrap">
          <span className="quick-switcher__input-icon">/</span>
          <input
            ref={inputRef}
            type="text"
            className="quick-switcher__input"
            placeholder="Search channels and conversations..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Quick switcher search"
          />
        </div>
        <div className="quick-switcher__results">
          {results.length === 0 && (
            <div className="quick-switcher__empty">No results found</div>
          )}
          {results.map((item, i) => (
            <button
              key={item.id + item.type}
              ref={(el) => { itemRefs.current[i] = el }}
              className={`quick-switcher__item ${i === selectedIndex ? 'quick-switcher__item--selected' : ''}`}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className={`quick-switcher__item-icon quick-switcher__item-icon--${item.type}`}>
                {item.type === 'text' && <Hash size={14} />}
                {item.type === 'voice' && <Volume2 size={14} />}
                {item.type === 'dm' && <AtSign size={14} />}
              </span>
              <div className="quick-switcher__item-info">
                <span className="quick-switcher__item-name">
                  {item.name}
                  {item.isRecent && !query && (
                    <span className="quick-switcher__item-recent-badge"><Clock size={10} /></span>
                  )}
                </span>
                <span className="quick-switcher__item-subtitle">{item.subtitle}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="quick-switcher__footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
