import { useEffect, useState, useRef, useCallback } from 'react'
import Slider from '../ui/Slider'
import { useServerStore } from '../../store/serverStore'
import {
  updateServerSettings,
  uploadServerBackground,
  deleteServerBackground,
  fetchServerInfo,
} from '@kizuna/shared'
import { handleApiErr, useMountedRef, fileToDataUrl } from './common'
import './OverviewSection.css'

export function OverviewSection({ serverUrl, onBackgroundChanged }: { serverUrl: string | undefined; onBackgroundChanged?: () => void }) {
  const { activeSession: session, updateServerInfo, servers } = useServerStore()
  const mountedRef = useMountedRef()

  const [serverName, setServerName] = useState(session ? servers.find(s => s.id === session.serverId)?.name ?? '' : '')
  const [serverIconPreview, setServerIconPreview] = useState<string | null>(
    session ? servers.find(s => s.id === session.serverId)?.icon ?? null : null,
  )
  const [serverIconChanged, setServerIconChanged] = useState(false)
  const [serverSaving, setServerSaving] = useState(false)
  const [serverMsg, setServerMsg] = useState<string | null>(null)
  const serverIconFileRef = useRef<HTMLInputElement>(null)
  const pendingServerIconFile = useRef<File | null>(null)

  const [bgHasImage, setBgHasImage] = useState(false)
  const [bgBlur, setBgBlur] = useState(0)
  const [bgPreviewTs, setBgPreviewTs] = useState(Date.now())
  const [bgUploading, setBgUploading] = useState(false)
  const bgFileRef = useRef<HTMLInputElement>(null)

  const [voiceBitrateKbps, setVoiceBitrateKbps] = useState(64)
  const [infoLoading, setInfoLoading] = useState(false)

  const serverIconDisplay = serverIconPreview

  const bgPreviewUrl = serverUrl && bgHasImage ? `${serverUrl}/api/server/background?t=${bgPreviewTs}` : null

  useEffect(() => {
    if (!serverUrl) { setInfoLoading(false); return }

    const delay = setTimeout(() => { if (mountedRef.current) setInfoLoading(true) }, 300)

    fetchServerInfo(serverUrl).then(info => {
      if (!mountedRef.current) return
      clearTimeout(delay)
      setBgHasImage(info.hasBackground)
      setBgBlur(info.backgroundBlur)
      setVoiceBitrateKbps(info.voiceBitrateKbps ?? 64)
      setInfoLoading(false)
    }).catch((err) => {
      console.error('Failed to fetch server info:', err)
      if (mountedRef.current) {
        clearTimeout(delay)
        setInfoLoading(false)
      }
    })

    return () => clearTimeout(delay)
  }, [serverUrl, mountedRef])

  // auto-save voice bitrate on change (ref-based so it survives modal close)
  const voiceBitrateSaveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const saveVoiceBitrate = useCallback((kbps: number) => {
    clearTimeout(voiceBitrateSaveTimerRef.current)
    voiceBitrateSaveTimerRef.current = setTimeout(async () => {
      const { activeSession } = useServerStore.getState()
      const url = activeSession?.url
      if (!url) return
      try {
        await updateServerSettings(url, undefined, undefined, undefined, undefined, kbps)
      } catch (err) {
        console.error('Failed to save voice bitrate:', err)
        const { activeSession } = useServerStore.getState()
        if (activeSession) setServerMsg(handleApiErr(err))
      }
    }, 300)
  }, [])

  // auto-save background blur on change (ref-based so it survives modal close)
  const bgBlurSaveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const saveBgBlur = useCallback((blur: number) => {
    clearTimeout(bgBlurSaveTimerRef.current)
    bgBlurSaveTimerRef.current = setTimeout(async () => {
      const url = useServerStore.getState().activeSession?.url
      if (!url) return
      try {
        await updateServerSettings(url, undefined, undefined, blur)
        onBackgroundChanged?.()
      } catch (err) {
        console.error('Failed to save background blur:', err)
        setServerMsg(handleApiErr(err))
      }
    }, 400)
  }, [onBackgroundChanged])

  const handleServerIconFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setServerMsg(null)
    pendingServerIconFile.current = file
    const url = URL.createObjectURL(file)
    setServerIconPreview(url)
    setServerIconChanged(true)
    e.target.value = ''
  }

  const handleSaveServer = async () => {
    if (!serverUrl || !session) return
    setServerSaving(true)
    setServerMsg(null)
    try {
      let iconPayload: string | null | undefined = undefined
      if (serverIconChanged) {
        if (serverIconPreview === null) {
          iconPayload = null
          pendingServerIconFile.current = null
        } else if (pendingServerIconFile.current) {
          iconPayload = await fileToDataUrl(pendingServerIconFile.current)
        }
      }
      const res = await updateServerSettings(serverUrl, serverName, iconPayload, bgBlur, undefined, voiceBitrateKbps)
      updateServerInfo(session.serverId, { name: res.name, icon: res.icon ?? undefined })
      setServerIconChanged(false)
      setServerIconPreview(res.icon ?? null)
      pendingServerIconFile.current = null
      setServerMsg('saved')
      setTimeout(() => setServerMsg(null), 3000)
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
    setServerSaving(false)
  }

  const handleBgFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    setServerMsg(null)
    setBgUploading(true)
    try {
      await uploadServerBackground(serverUrl, file)
      setBgHasImage(true)
      setBgPreviewTs(Date.now())
      onBackgroundChanged?.()
      setServerMsg('background uploaded')
      setTimeout(() => setServerMsg(null), 3000)
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
    setBgUploading(false)
    e.target.value = ''
  }

  const handleRemoveBg = async () => {
    if (!serverUrl) return
    setServerMsg(null)
    try {
      await deleteServerBackground(serverUrl)
      setBgHasImage(false)
      setBgPreviewTs(Date.now())
      onBackgroundChanged?.()
      setServerMsg('background removed')
      setTimeout(() => setServerMsg(null), 3000)
    } catch (err) {
      setServerMsg(handleApiErr(err))
    }
  }

  return (
    <div className="server-menu__section">
      {infoLoading && <p className="server-menu__info-loading">loading server info...</p>}

      {/* Identity */}
      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">identity</p>
        <div className="server-menu__avatar-row">
          <div className="server-menu__avatar" onClick={() => serverIconFileRef.current?.click()} title="click to change server icon">
            <span>{(serverName || '?').slice(0, 2).toUpperCase()}</span>
            {serverIconDisplay && (
              <img src={serverIconDisplay} alt="" className="server-menu__avatar-img"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
            )}
          </div>
          <div className="server-menu__avatar-actions">
            <button onClick={() => serverIconFileRef.current?.click()} className="server-menu__upload-btn">upload icon</button>
            {(serverIconPreview) && (
              <button onClick={() => { pendingServerIconFile.current = null; setServerIconPreview(null); setServerIconChanged(true) }}
                className="server-menu__remove-btn">remove icon</button>
            )}
          </div>
          <input ref={serverIconFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleServerIconFile} />
        </div>
        <div className="server-menu__field" style={{ marginTop: '10px' }}>
          <label className="server-menu__label">server name</label>
          <input className="server-menu__input" maxLength={100} value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="server name" />
        </div>
      </div>

      {/* Appearance */}
      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">appearance</p>
        <div className="server-menu__field">
          <label className="server-menu__label">background image</label>
          <div className="server-menu__bg-row">
            <div
              className={`server-menu__bg-preview${!bgPreviewUrl ? ' server-menu__bg-preview--empty' : ''}`}
              style={bgPreviewUrl ? { backgroundImage: `url(${bgPreviewUrl})` } : undefined}
            >
              {!bgPreviewUrl && <span className="server-menu__bg-preview-placeholder">no image</span>}
            </div>
            <div className="server-menu__bg-actions">
              <button onClick={() => bgFileRef.current?.click()} disabled={bgUploading} className="server-menu__upload-btn">
                {bgUploading ? 'uploading...' : bgHasImage ? 'change' : 'upload background'}
              </button>
              {bgHasImage && (
                <button onClick={handleRemoveBg} className="server-menu__remove-btn">remove</button>
              )}
            </div>
            <input ref={bgFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgFile} />
          </div>
        </div>
        <div className="server-menu__field" style={{ marginTop: '10px' }}>
          <div className="server-menu__label-row">
            <label className="server-menu__label">background blur</label>
            <span className="server-menu__value-chip">{bgBlur}px</span>
          </div>
          <Slider min={0} max={20} value={bgBlur} onChange={(v) => { setBgBlur(v); saveBgBlur(v) }} ariaLabel="Background blur" />
        </div>
      </div>

      {/* Voice */}
      <div className="server-menu__settings-group">
        <p className="server-menu__settings-group-title">voice</p>
        <div className="server-menu__field">
          <label className="server-menu__label">bitrate</label>
          <select
            value={voiceBitrateKbps}
            onChange={(e) => { const kbps = Number(e.target.value); setVoiceBitrateKbps(kbps); saveVoiceBitrate(kbps) }}
            className="server-menu__select"
          >
            <option value={32}>32 kbps — low bandwidth</option>
            <option value={64}>64 kbps — balanced</option>
            <option value={96}>96 kbps</option>
            <option value={128}>128 kbps — high quality</option>
            <option value={192}>192 kbps</option>
            <option value={256}>256 kbps</option>
            <option value={320}>320 kbps — max quality</option>
          </select>
          <p className="server-menu__hint">applies immediately to all connected users</p>
        </div>
      </div>

      <div className="server-menu__save-row">
        <button onClick={handleSaveServer} disabled={serverSaving} className="server-menu__save-btn">
          {serverSaving ? 'saving...' : 'save settings'}
        </button>
        {serverMsg && (
          <span className={`server-menu__save-msg ${serverMsg === 'saved' || serverMsg.startsWith('background') ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`}>
            {serverMsg}
          </span>
        )}
      </div>
    </div>
  )
}
