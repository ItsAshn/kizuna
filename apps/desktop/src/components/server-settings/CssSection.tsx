import { useEffect, useState } from 'react'
import { useServerStore } from '../../store/serverStore'
import { updateServerSettings, fetchServerInfo } from '@kizuna/shared'
import { handleApiErr, useMountedRef } from './common'

export function CssSection({ serverUrl, onBackgroundChanged }: { serverUrl: string | undefined; onBackgroundChanged?: () => void }) {
  const { activeSession: session } = useServerStore()
  const mountedRef = useMountedRef()

  const [customCss, setCustomCss] = useState('')
  const [customCssSaving, setCustomCssSaving] = useState(false)
  const [customCssMsg, setCustomCssMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!serverUrl) return
    fetchServerInfo(serverUrl).then(info => {
      if (!mountedRef.current) return
      setCustomCss(info.customCss || '')
    }).catch((err) => {
      console.error('Failed to fetch server info:', err)
    })
  }, [serverUrl, mountedRef])

  // live preview while editing; removed again on unmount
  useEffect(() => {
    const previewEl = document.getElementById('kizuna-custom-css-preview') as HTMLStyleElement | null
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
        Override CSS variables to theme your server. Changes preview live.
      </p>
      <div className="server-menu__css-body">
        <textarea
          className="server-menu__css-editor"
          value={customCss}
          onChange={(e) => setCustomCss(e.target.value.slice(0, 50000))}
          maxLength={50000}
          placeholder={`/* Kizuna Custom CSS — override any variable below */\n:root {\n  /* Backgrounds */\n  --bg-primary: #0a0a0a;\n  --bg-secondary: #111111;\n  --bg-tertiary: #1a1a1a;\n  --bg-hover: #262626;\n  --bg-active: #2d2d2d;\n\n  /* Text */\n  --text-primary: #ffffff;\n  --text-secondary: #a0a0a0;\n  --text-muted: #6b6b6b;\n\n  /* Borders */\n  --border-color: #2a2a2a;\n\n  /* Brand / Accent */\n  --brand: #4c6ef5;\n  --brand-hover: #4263eb;\n  --brand-dim: rgba(76, 110, 245, 0.15);\n  --accent-color: #6366f1;\n\n  /* Semantic colors */\n  --red: #ff4d4d;\n  --red-hover: #ff3333;\n  --red-dim: rgba(255, 77, 77, 0.15);\n  --red-dim-border: rgba(255, 77, 77, 0.30);\n  --green: #40c057;\n  --green-dim: rgba(64, 192, 87, 0.15);\n  --green-dim-border: rgba(64, 192, 87, 0.20);\n  --yellow: #fab005;\n\n  /* Border radius */\n  --radius-sm: 8px;\n  --radius-md: 12px;\n  --radius-lg: 16px;\n  --radius-xl: 24px;\n  --radius-full: 9999px;\n\n  /* Font */\n  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;\n}`}
          spellCheck={false}
        />
        <div className="server-menu__save-row" style={{ marginTop: 0 }}>
          <button onClick={handleSaveCustomCss} disabled={customCssSaving || customCss.length > 50000} className="server-menu__save-btn">
            {customCssSaving ? '...' : 'save css'}
          </button>
          <span className={`server-menu__css-char-count${customCss.length > 45000 ? ' server-menu__css-char-count--warn' : ''}${customCss.length >= 50000 ? ' server-menu__css-char-count--over' : ''}`}>
            {customCss.length.toLocaleString()} / 50,000
          </span>
          {customCssMsg && (
            <span className={`server-menu__save-msg ${customCssMsg === 'saved' ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
              {customCssMsg}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
