import { useEffect, useState } from 'react'
import { useServerStore } from '../../store/serverStore'
import { updateServerSettings, fetchServerInfo } from '@kizuna/shared'
import { handleApiErr, useMountedRef } from './common'
import './CssSection.css'

/**
 * Shown in the empty editor. Mirrors the real defaults in styles/global.css —
 * the tokens most people reach for first, with the derived ones (--brand-dim,
 * the elevation scale) left out since they follow from their primitive.
 */
const CSS_PLACEHOLDER = `/* Kizuna custom CSS — override any variable below. */
:root {
  /* Backgrounds */
  --bg-primary: #0a0a0a;
  --bg-secondary: #111111;
  --bg-tertiary: #1a1a1a;
  --bg-hover: #262626;
  --bg-active: #2d2d2d;

  /* Text */
  --text-primary: #ffffff;
  --text-secondary: #a0a0a0;
  --text-muted: #808080;

  /* Borders */
  --border-color: #2a2a2a;

  /* Brand — the dim/glow variants derive from these */
  --brand: #a1d93f;
  --brand-hover: #8cc22e;
  --accent-color: #a1d93f;

  /* Semantic */
  --red: #ff4d4d;
  --green: #40c057;
  --yellow: #fab005;

  /* Labels sitting on a filled surface */
  --on-brand: #ffffff;
  --on-danger: #ffffff;

  /* Shadows are all cast in this colour — try a brand hue for glows */
  --shadow: #000000;

  /* Shape */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --radius-full: 9999px;

  /* Font (locally installed families only — url() is not allowed) */
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}`

export function CssSection({
  serverUrl,
  onBackgroundChanged,
}: {
  serverUrl: string | undefined
  onBackgroundChanged?: () => void
}) {
  const { activeSession: session } = useServerStore()
  const mountedRef = useMountedRef()

  const [customCss, setCustomCss] = useState('')
  const [customCssSaving, setCustomCssSaving] = useState(false)
  const [customCssMsg, setCustomCssMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!serverUrl) return
    fetchServerInfo(serverUrl)
      .then((info) => {
        if (!mountedRef.current) return
        setCustomCss(info.customCss || '')
      })
      .catch((err) => {
        console.error('Failed to fetch server info:', err)
      })
  }, [serverUrl, mountedRef])

  // live preview while editing; removed again on unmount
  useEffect(() => {
    const previewEl = document.getElementById(
      'kizuna-custom-css-preview',
    ) as HTMLStyleElement | null
    if (customCss) {
      if (previewEl) {
        previewEl.textContent = customCss
      } else {
        const style = document.createElement('style')
        style.id = 'kizuna-custom-css-preview'
        style.textContent = customCss
        document.head.appendChild(style)
      }
    } else if (previewEl) {
      previewEl.remove()
    }
    return () => {
      const el = document.getElementById('kizuna-custom-css-preview')
      if (el) el.remove()
    }
  }, [customCss])

  const handleSaveCustomCss = async () => {
    if (!serverUrl || !session) return
    setCustomCssSaving(true)
    setCustomCssMsg(null)
    try {
      const cssValue = customCss.trim() || null
      await updateServerSettings(serverUrl, undefined, undefined, undefined, cssValue)
      if (cssValue) {
        setCustomCss(cssValue)
      }
      onBackgroundChanged?.()
      setCustomCssMsg('saved')
      setTimeout(() => setCustomCssMsg(null), 3000)
    } catch (err) {
      setCustomCssMsg(handleApiErr(err))
    }
    setCustomCssSaving(false)
  }

  return (
    <section className="server-menu__section--grow">
      <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
        Override CSS variables to theme your server. Changes preview live. Full token reference and
        an example theme: use-kizuna.com/kizuna/guide/theming
      </p>
      <div className="server-menu__css-body">
        <textarea
          className="server-menu__css-editor"
          value={customCss}
          onChange={(e) => setCustomCss(e.target.value.slice(0, 50000))}
          maxLength={50000}
          placeholder={CSS_PLACEHOLDER}
          spellCheck={false}
        />
        <div className="server-menu__save-row" style={{ marginTop: 0 }}>
          <button
            onClick={handleSaveCustomCss}
            disabled={customCssSaving || customCss.length > 50000}
            className="server-menu__save-btn"
          >
            {customCssSaving ? '...' : 'save css'}
          </button>
          <span
            className={`server-menu__css-char-count${customCss.length > 45000 ? ' server-menu__css-char-count--warn' : ''}${customCss.length >= 50000 ? ' server-menu__css-char-count--over' : ''}`}
          >
            {customCss.length.toLocaleString()} / 50,000
          </span>
          {customCssMsg && (
            <span
              className={`server-menu__save-msg ${customCssMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}
            >
              {customCssMsg}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
