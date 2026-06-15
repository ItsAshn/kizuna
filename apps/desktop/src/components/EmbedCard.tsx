import { useState, useEffect } from 'react'
import { unfurlUrls } from '@kizuna/shared'
import { useServerStore } from '../store/serverStore'
import '../styles/embed-card.css'

interface EmbedCardProps {
  urls: string[]
}

export default function EmbedCard({ urls }: EmbedCardProps) {
  const session = useServerStore((s) => s.activeSession)
  const [embeds, setEmbeds] = useState<Record<string, any>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!session || urls.length === 0) return
    unfurlUrls(session.url, urls).then(setEmbeds).catch(() => {}).finally(() => setLoaded(true))
  }, [urls.join(','), session?.url])

  if (!loaded || Object.keys(embeds).length === 0) return null

  return (
    <div className="embed-card-list">
      {urls.map((url) => {
        const embed = embeds[url]
        if (!embed?.title) return null
        return (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="embed-card"
          >
            <div className="embed-card__accent" />
            <div className="embed-card__body">
              <div className="embed-card__header">
                {embed.favicon && <img src={embed.favicon} alt="" className="embed-card__favicon" />}
                <span className="embed-card__site">{embed.siteName || new URL(url).hostname}</span>
              </div>
              <span className="embed-card__title">{embed.title}</span>
              {embed.description && (
                <span className="embed-card__desc">{embed.description}</span>
              )}
            </div>
            {embed.image && (
              <img src={embed.image} alt="" className="embed-card__thumb" />
            )}
          </a>
        )
      })}
    </div>
  )
}
