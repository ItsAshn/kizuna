import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { fetchGifs, fetchGifCategories, fetchStickerPacks } from '@kizuna/shared'
import type { GifInfo, GifType } from '@kizuna/shared'
import '../styles/gif-picker.css'

interface GifPickerProps {
  serverUrl: string
  onSelect: (url: string, displayName: string, type: GifType) => void
  onClose: () => void
}

type Tab = 'gifs' | 'stickers'

export default function GifPicker({ serverUrl, onSelect, onClose }: GifPickerProps) {
  const [activeTab, setActiveTab] = useState<Tab>('gifs')
  const [items, setItems] = useState<GifInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [packs, setPacks] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState('')
  const [activePack, setActivePack] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: { type?: 'gif' | 'sticker'; category?: string; pack?: string; search?: string; limit: number } = {
        type: activeTab === 'stickers' ? 'sticker' : 'gif',
        limit: 100,
      }
      if (activeTab === 'gifs' && activeCategory) params.category = activeCategory
      if (activeTab === 'stickers' && activePack) params.pack = activePack
      if (search.trim()) params.search = search.trim()

      const gifs = await fetchGifs(serverUrl, params as any)
      setItems(gifs)
    } catch {
      setError('Failed to load')
    }
    setLoading(false)
  }, [serverUrl, activeTab, activeCategory, activePack, search])

  useEffect(() => {
    loadItems()
  }, [loadItems])

  useEffect(() => {
    if (activeTab === 'gifs') {
      fetchGifCategories(serverUrl, 'gif')
        .then(setCategories)
        .catch(() => setCategories([]))
    } else {
      fetchStickerPacks(serverUrl)
        .then(setPacks)
        .catch(() => setPacks([]))
    }
  }, [activeTab, serverUrl])

  useEffect(() => {
    setActiveCategory('')
    setActivePack('')
    setSearch('')
  }, [activeTab])

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    if (searchTimeout.current) clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => {
      setSearch(val)
    }, 300)
  }

  const handleSelect = (item: GifInfo) => {
    const resolvedUrl = item.file_url.startsWith('/') ? `${serverUrl}${item.file_url}` : item.file_url
    onSelect(resolvedUrl, item.display_name, item.type)
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="gif-picker__overlay" onClick={handleOverlayClick}>
      <div className="gif-picker">
        <div className="gif-picker__header">
          <div className="gif-picker__tabs">
            <button
              className={`gif-picker__tab ${activeTab === 'gifs' ? 'gif-picker__tab--active' : ''}`}
              onClick={() => setActiveTab('gifs')}
            >
              GIFs
            </button>
            <button
              className={`gif-picker__tab ${activeTab === 'stickers' ? 'gif-picker__tab--active' : ''}`}
              onClick={() => setActiveTab('stickers')}
            >
              Stickers
            </button>
          </div>
          <button className="gif-picker__close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="gif-picker__search">
          <Search size={14} className="gif-picker__search-icon" />
          <input
            className="gif-picker__search-input"
            placeholder={`Search ${activeTab}...`}
            onChange={handleSearchChange}
            autoFocus
          />
        </div>

        {activeTab === 'gifs' && categories.length > 0 && (
          <div className="gif-picker__filters">
            <button
              className={`gif-picker__filter ${!activeCategory ? 'gif-picker__filter--active' : ''}`}
              onClick={() => setActiveCategory('')}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                className={`gif-picker__filter ${activeCategory === cat ? 'gif-picker__filter--active' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {activeTab === 'stickers' && packs.length > 0 && (
          <div className="gif-picker__filters">
            {packs.map((pack) => (
              <button
                key={pack}
                className={`gif-picker__filter ${activePack === pack ? 'gif-picker__filter--active' : ''}`}
                onClick={() => setActivePack(pack)}
              >
                {pack}
              </button>
            ))}
          </div>
        )}

        <div className="gif-picker__grid">
          {loading && <div className="gif-picker__status">Loading...</div>}
          {error && <div className="gif-picker__status gif-picker__status--error">{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div className="gif-picker__status">
              {search ? 'Nothing found' : activeTab === 'gifs' ? 'No GIFs yet' : 'No sticker packs yet'}
            </div>
          )}
          {!loading && !error && items.map((item) => {
            const resolvedUrl = item.file_url.startsWith('/') ? `${serverUrl}${item.file_url}` : item.file_url
            const scale = item.type === 'sticker' ? 3 : 2
            const displayWidth = item.width ? Math.round(item.width / scale) : undefined
            const displayHeight = item.height ? Math.round(item.height / scale) : undefined
            return (
              <div
                key={item.id}
                className="gif-picker__item"
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setHoveredId(item.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <img
                  src={resolvedUrl}
                  alt={item.display_name}
                  className="gif-picker__img"
                  loading="lazy"
                  width={displayWidth}
                  height={displayHeight}
                />
                {hoveredId === item.id && (
                  <div className="gif-picker__item-name">{item.display_name}</div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
