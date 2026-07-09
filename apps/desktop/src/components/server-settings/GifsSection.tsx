import { useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import {
  fetchGifs,
  uploadGif,
  uploadGifPack,
  uploadSticker,
  uploadStickerPack,
  deleteStickerPack,
  updateGif,
  deleteGif,
  generateGifTags,
  getTaggerStatus,
  loadTagger,
  unloadTagger,
} from '@kizuna/shared'
import type { GifInfo, TaggerStatus } from '@kizuna/shared'
import Modal from '../ui/Modal'
import Tabs from '../ui/Tabs'
import { handleApiErr, useMountedRef } from './common'
import './GifsSection.css'

const GIF_TABS: { key: 'gif' | 'sticker'; label: string }[] = [
  { key: 'gif', label: 'gif' },
  { key: 'sticker', label: 'sticker' },
]

export function GifsSection({ serverUrl }: { serverUrl: string | undefined }) {
  const mountedRef = useMountedRef()
  const [gifsList, setGifsList] = useState<GifInfo[]>([])
  const [gifsLoading, setGifsLoading] = useState(false)
  const [taggerStatus, setTaggerStatus] = useState<TaggerStatus>({ loaded: false, loading: false, enabled: false })
  const [taggerLoading, setTaggerLoading] = useState(false)
  const [showTaggerWarning, setShowTaggerWarning] = useState(false)
  const [gifUploading, setGifUploading] = useState(false)
  const [gifMsg, setGifMsg] = useState<string | null>(null)
  const [gifTab, setGifTab] = useState<'gif' | 'sticker'>('gif')
  const [gifName, setGifName] = useState('')
  const [gifCategory, setGifCategory] = useState('')
  const [gifTags, setGifTags] = useState('')
  const [editingGifId, setEditingGifId] = useState<string | null>(null)
  const [gifEditName, setGifEditName] = useState('')
  const [gifEditCategory, setGifEditCategory] = useState('')
  const [gifEditTags, setGifEditTags] = useState('')
  const [generatingTags, setGeneratingTags] = useState<Set<string>>(new Set())
  const gifFileRef = useRef<HTMLInputElement>(null)
  const gifPackFileRef = useRef<HTMLInputElement>(null)
  const stickerPackFileRef = useRef<HTMLInputElement>(null)
  const singleStickerFileRef = useRef<HTMLInputElement>(null)
  // Styled popup for naming a sticker pack when importing a .zip (replaces window.prompt)
  const [packNameModal, setPackNameModal] = useState<{ open: boolean; file: File | null; name: string }>(
    { open: false, file: null, name: '' },
  )
  // Styled popup for uploading a single sticker into an existing or new pack
  const [stickerUpload, setStickerUpload] = useState<{
    open: boolean
    file: File | null
    selectedPack: string // '' means "create a new pack"
    newPackName: string
    displayName: string
    uploading: boolean
  }>({ open: false, file: null, selectedPack: '', newPackName: '', displayName: '', uploading: false })

  useEffect(() => {
    loadGifs()
    loadTaggerStatus()
  }, [serverUrl])

  async function loadGifs() {
    if (!serverUrl) return
    setGifsLoading(true)
    try {
      const gifs = await fetchGifs(serverUrl, { limit: 200 })
      if (mountedRef.current) setGifsList(gifs)
    } catch (err) {
      console.error('Failed to fetch gifs:', err)
    }
    if (mountedRef.current) setGifsLoading(false)
  }

  async function loadTaggerStatus() {
    if (!serverUrl) return
    try {
      const status = await getTaggerStatus(serverUrl)
      if (mountedRef.current) setTaggerStatus(status)
    } catch {
      // ignore — server might not have tagging or the endpoint yet
    }
  }

  async function handleLoadTagger() {
    if (!serverUrl) return
    setShowTaggerWarning(false)
    setTaggerLoading(true)
    try {
      await loadTagger(serverUrl)
      if (mountedRef.current) setTaggerStatus({ loaded: true, loading: false, enabled: true })
    } catch (err) {
      setGifMsg(handleApiErr(err))
      if (mountedRef.current) setTaggerStatus({ loaded: false, loading: false, enabled: true })
    } finally {
      if (mountedRef.current) setTaggerLoading(false)
    }
  }

  async function handleUnloadTagger() {
    if (!serverUrl) return
    try {
      await unloadTagger(serverUrl)
      if (mountedRef.current) setTaggerStatus({ loaded: false, loading: false, enabled: true })
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleGifFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    const name = gifName.trim() || file.name.replace(/\.[^.]+$/, '')
    setGifUploading(true)
    setGifMsg(null)
    try {
      await uploadGif(serverUrl, file, name, gifCategory.trim() || undefined, gifTags.trim() || undefined)
      setGifMsg('uploaded')
      setGifName('')
      setGifCategory('')
      setGifTags('')
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
    e.target.value = ''
  }

  const handleGifPackFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    setGifUploading(true)
    setGifMsg(null)
    try {
      const result = await uploadGifPack(serverUrl, file)
      setGifMsg(`imported ${result.imported} GIFs`)
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
    e.target.value = ''
  }

  const handleStickerPackFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !serverUrl) return
    setPackNameModal({ open: true, file, name: '' })
    e.target.value = ''
  }

  const confirmStickerPackUpload = async () => {
    const { file, name } = packNameModal
    if (!file || !serverUrl || !name.trim()) return
    setGifUploading(true)
    setGifMsg(null)
    try {
      const result = await uploadStickerPack(serverUrl, file, name.trim())
      setGifMsg(`imported ${result.imported} stickers`)
      loadGifs()
      setPackNameModal({ open: false, file: null, name: '' })
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
    setGifUploading(false)
  }

  const openStickerUpload = (pack?: string) => {
    setStickerUpload({
      open: true,
      file: null,
      selectedPack: pack ?? '',
      newPackName: '',
      displayName: '',
      uploading: false,
    })
  }

  const confirmStickerUpload = async () => {
    if (!serverUrl) return
    const packName = (stickerUpload.selectedPack || stickerUpload.newPackName).trim()
    if (!stickerUpload.file || !packName) return
    setStickerUpload((s) => ({ ...s, uploading: true }))
    setGifMsg(null)
    try {
      await uploadSticker(
        serverUrl,
        stickerUpload.file,
        packName,
        stickerUpload.displayName.trim() || undefined,
      )
      setGifMsg('uploaded')
      loadGifs()
      setStickerUpload({ open: false, file: null, selectedPack: '', newPackName: '', displayName: '', uploading: false })
    } catch (err) {
      setGifMsg(handleApiErr(err))
      setStickerUpload((s) => ({ ...s, uploading: false }))
    }
  }

  const handleDeleteGif = async (id: string) => {
    if (!serverUrl) return
    try {
      await deleteGif(serverUrl, id)
      setGifsList(prev => prev.filter(g => g.id !== id))
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleStartEdit = (gif: GifInfo) => {
    setEditingGifId(gif.id)
    setGifEditName(gif.display_name)
    setGifEditCategory(gif.category)
    setGifEditTags(gif.tags)
  }

  const handleCancelEdit = () => {
    setEditingGifId(null)
    setGifEditName('')
    setGifEditCategory('')
    setGifEditTags('')
  }

  const handleSaveEdit = async () => {
    if (!serverUrl || !editingGifId) return
    const name = gifEditName.trim()
    if (!name) return
    try {
      await updateGif(serverUrl, editingGifId, {
        display_name: name,
        category: gifEditCategory.trim() || undefined,
        tags: gifEditTags.trim() || undefined,
      })
      setEditingGifId(null)
      setGifEditName('')
      setGifEditCategory('')
      setGifEditTags('')
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleGenerateTags = async (gifId: string) => {
    if (!serverUrl) return
    setGeneratingTags(prev => new Set(prev).add(gifId))
    try {
      const updated = await generateGifTags(serverUrl, gifId)
      setGifsList(prev => prev.map(g => g.id === gifId ? updated : g))
    } catch (err) {
      setGifMsg(handleApiErr(err))
    } finally {
      setGeneratingTags(prev => {
        const next = new Set(prev)
        next.delete(gifId)
        return next
      })
    }
  }

  const handleAcceptSuggestedTag = (gif: GifInfo, tag: string) => {
    const existing = gifEditTags.split(',').map(t => t.trim()).filter(Boolean)
    if (existing.includes(tag)) return
    setGifEditTags([...existing, tag].join(', '))
  }

  const handleDismissSuggestedTags = async (gifId: string) => {
    if (!serverUrl) return
    try {
      const updated = await updateGif(serverUrl, gifId, { suggested_tags: '' })
      setGifsList(prev => prev.map(g => g.id === gifId ? updated : g))
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  const handleGenerateAllTags = async () => {
    if (!serverUrl) return
    const gifs = gifsList.filter(g => g.type === 'gif')
    for (const gif of gifs) {
      setGeneratingTags(prev => new Set(prev).add(gif.id))
      try {
        const updated = await generateGifTags(serverUrl, gif.id)
        setGifsList(prev => prev.map(g => g.id === gif.id ? updated : g))
      } catch (err) {
        setGifMsg(handleApiErr(err))
        break
      } finally {
        setGeneratingTags(prev => {
          const next = new Set(prev)
          next.delete(gif.id)
          return next
        })
      }
    }
  }

  const handleDeleteStickerPack = async (packName: string) => {
    if (!confirm(`Delete sticker pack "${packName}" and all its stickers?`)) return
    if (!serverUrl) return
    try {
      await deleteStickerPack(serverUrl, packName)
      loadGifs()
    } catch (err) {
      setGifMsg(handleApiErr(err))
    }
  }

  return (
    <>
    <div className="server-menu__section">

      <div className="server-menu__tab-bar" style={{ marginBottom: '12px' }}>
        <Tabs
          tabs={GIF_TABS}
          activeKey={gifTab}
          onChange={(key) => setGifTab(key as 'gif' | 'sticker')}
          variant="pill"
        />
      </div>

      {gifTab === 'gif' && (
        <>
          <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>upload single gif</p>
          <div className="server-menu__gif-upload">
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <div className="server-menu__field" style={{ flex: 1 }}>
                <label className="server-menu__label">name (optional)</label>
                <input className="server-menu__input" value={gifName} onChange={(e) => setGifName(e.target.value)} placeholder="display name" />
              </div>
              <div className="server-menu__field" style={{ flex: 1 }}>
                <label className="server-menu__label">category (optional)</label>
                <input className="server-menu__input" value={gifCategory} onChange={(e) => setGifCategory(e.target.value)} placeholder="e.g. memes" />
              </div>
            </div>
            <div className="server-menu__field" style={{ marginBottom: '8px' }}>
              <label className="server-menu__label">tags — comma separated (optional)</label>
              <input className="server-menu__input" value={gifTags} onChange={(e) => setGifTags(e.target.value)} placeholder="e.g. funny, cat" />
            </div>
            <button onClick={() => gifFileRef.current?.click()} disabled={gifUploading || !gifName.trim()} className="server-menu__upload-btn">
              {gifUploading ? 'uploading...' : 'choose .gif file'}
            </button>
            {!gifName.trim() && <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'block', marginTop: '4px' }}>name is required</span>}
            <input ref={gifFileRef} type="file" accept=".gif" style={{ display: 'none' }} onChange={handleGifFile} />
          </div>

          <p className="server-menu__section-title" style={{ marginTop: '16px', marginBottom: '6px', fontSize: '11px' }}>upload gif pack (.zip)</p>
          <div className="server-menu__gif-upload" style={{ marginBottom: '16px' }}>
            <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
              Upload a .zip of .gif files. Optionally include a pack.json manifest.
            </p>
            <button onClick={() => gifPackFileRef.current?.click()} disabled={gifUploading} className="server-menu__upload-btn">
              {gifUploading ? 'uploading...' : 'choose .zip file'}
            </button>
            <input ref={gifPackFileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleGifPackFile} />
          </div>

          {gifMsg && (
            <span className={`server-menu__save-msg ${gifMsg === 'uploaded' || gifMsg.startsWith('imported') ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`} style={{ marginBottom: '8px', display: 'block' }}>
              {gifMsg}
            </span>
          )}

          {taggerStatus.enabled && !taggerStatus.loaded && !taggerStatus.loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              {showTaggerWarning ? (
                <>
                  <span style={{ fontSize: '11px', color: '#e8b851', flex: 1 }}>
                    This will load a CLIP ViT-B/32 model using ~1.5 GB of RAM. Continue?
                  </span>
                  <button onClick={handleLoadTagger} disabled={taggerLoading} className="server-menu__upload-btn" style={{ fontSize: '11px', padding: '4px 8px' }}>
                    {taggerLoading ? 'loading...' : 'yes, load it'}
                  </button>
                  <button onClick={() => setShowTaggerWarning(false)} className="server-menu__upload-btn" style={{ fontSize: '11px', padding: '4px 8px' }}>
                    cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowTaggerWarning(true)}
                  disabled={taggerLoading}
                  className="server-menu__upload-btn"
                  style={{ fontSize: '11px', padding: '4px 8px' }}
                  title="Load the CLIP AI model for auto-tagging GIFs"
                >
                  {taggerLoading ? 'loading...' : 'load tagging model'}
                </button>
              )}
            </div>
          )}
          {taggerStatus.loading && (
            <p style={{ fontSize: '11px', color: '#888', margin: '0 0 8px 0' }}>loading tagging model... this may take a minute</p>
          )}
          {taggerStatus.loaded && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', color: '#6f6' }}>model loaded</span>
              <button onClick={handleUnloadTagger} disabled={generatingTags.size > 0} className="server-menu__upload-btn" style={{ fontSize: '11px', padding: '4px 8px' }}>
                unload
              </button>
            </div>
          )}

          <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>gif library ({gifsList.filter(g => g.type === 'gif').length})</p>
          {taggerStatus.loaded && (
          <button
            onClick={handleGenerateAllTags}
            disabled={generatingTags.size > 0}
            className="server-menu__upload-btn"
            style={{ marginBottom: '8px', fontSize: '11px', padding: '4px 8px' }}
            title="Generate AI tags for all GIFs that don't have suggested tags yet"
          >
            {generatingTags.size > 0 ? 'generating tags...' : '✨ generate tags for all'}
          </button>
          )}
          {gifsLoading ? (
            <p className="server-menu__loading">loading...</p>
          ) : gifsList.filter(g => g.type === 'gif').length === 0 ? (
            <p className="server-menu__loading">no gifs uploaded yet</p>
          ) : (
            <div className="server-menu__gif-grid">
              {gifsList.filter(g => g.type === 'gif').map(gif => {
                const resolvedUrl = gif.file_url.startsWith('/') ? `${serverUrl}${gif.file_url}` : gif.file_url
                const isEditing = editingGifId === gif.id
                return (
                  <div key={gif.id} className="server-menu__gif-item">
                    <img src={resolvedUrl} alt={gif.display_name} className="server-menu__gif-thumb" />
                    <div className="server-menu__gif-item-info">
                      <span className="server-menu__gif-item-name">{gif.display_name}</span>
                      <span className="server-menu__gif-item-cat">{gif.category}</span>
                    </div>
                    <button
                      onClick={() => handleStartEdit(gif)}
                      className="server-menu__gif-edit"
                      title="Edit GIF"
                    >
                      <Pencil size={12} />
                    </button>
                    {taggerStatus.loaded && (
                    <button
                      onClick={() => handleGenerateTags(gif.id)}
                      className="server-menu__gif-ai"
                      title="Generate tags with AI"
                      disabled={generatingTags.has(gif.id)}
                    >
                      {generatingTags.has(gif.id) ? '...' : <span style={{ fontSize: '10px' }}>AI</span>}
                    </button>
                    )}
                    <button
                      onClick={() => handleDeleteGif(gif.id)}
                      className="server-menu__gif-delete"
                      title="Delete GIF"
                    >
                      <X size={12} />
                    </button>
                    {isEditing && (
                      <div className="server-menu__gif-popover">
                        <input value={gifEditName} onChange={e => setGifEditName(e.target.value)} placeholder="name" />
                        <input value={gifEditCategory} onChange={e => setGifEditCategory(e.target.value)} placeholder="category" />
                        <input value={gifEditTags} onChange={e => setGifEditTags(e.target.value)} placeholder="tags (comma separated)" />
                        {gif.suggested_tags && (
                          <div className="server-menu__gif-suggested">
                            <div className="server-menu__gif-suggested-header">
                              <span>suggested tags</span>
                              <button
                                onClick={() => handleDismissSuggestedTags(gif.id)}
                                className="server-menu__gif-suggested-dismiss"
                                title="Dismiss all suggestions"
                              >
                                dismiss all
                              </button>
                            </div>
                            <div className="server-menu__gif-suggested-list">
                              {gif.suggested_tags.split(',').map((t: string) => {
                                const tag = t.trim()
                                if (!tag) return null
                                const currentTags = gifEditTags.split(',').map((ct: string) => ct.trim()).filter(Boolean)
                                const alreadyAdded = currentTags.includes(tag)
                                return (
                                  <button
                                    key={tag}
                                    onClick={() => handleAcceptSuggestedTag(gif, tag)}
                                    className={`server-menu__gif-suggested-tag ${alreadyAdded ? 'server-menu__gif-suggested-tag--accepted' : ''}`}
                                    disabled={alreadyAdded}
                                    title={alreadyAdded ? 'Already added' : 'Click to accept'}
                                  >
                                    {alreadyAdded ? '✓' : '+'} {tag}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                        <div className="server-menu__gif-popover-actions">
                          <button onClick={handleCancelEdit} className="server-menu__gif-popover-btn server-menu__gif-popover-btn--cancel">cancel</button>
                          <button onClick={handleSaveEdit} disabled={!gifEditName.trim()} className="server-menu__gif-popover-btn server-menu__gif-popover-btn--save">save</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {gifTab === 'sticker' && (
        <>
          <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>upload sticker pack (.zip)</p>
          <div className="server-menu__gif-upload" style={{ marginBottom: '16px' }}>
            <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
              Upload a .zip containing .gif, .png, or .webp stickers. Optionally include a pack.json manifest.
            </p>
            <button onClick={() => stickerPackFileRef.current?.click()} disabled={gifUploading} className="server-menu__upload-btn">
              {gifUploading ? 'uploading...' : 'choose .zip file'}
            </button>
            <input ref={stickerPackFileRef} type="file" accept=".zip" style={{ display: 'none' }} onChange={handleStickerPackFile} />
          </div>

          <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>add a single sticker</p>
          <div className="server-menu__gif-upload" style={{ marginBottom: '16px' }}>
            <p className="server-menu__css-hint" style={{ marginBottom: '8px' }}>
              Upload one .gif, .png, or .webp sticker into an existing pack or a brand-new one.
            </p>
            <button onClick={() => openStickerUpload()} disabled={gifUploading} className="server-menu__upload-btn">
              add sticker
            </button>
          </div>

          {gifMsg && (
            <span className={`server-menu__save-msg ${gifMsg === 'uploaded' || gifMsg.startsWith('imported') ? 'server-menu__save-msg--ok' : 'server-menu__save-msg--err'}`} style={{ marginBottom: '8px', display: 'block' }}>
              {gifMsg}
            </span>
          )}

          <p className="server-menu__section-title" style={{ marginBottom: '6px', fontSize: '11px' }}>sticker packs</p>
          {gifsLoading ? (
            <p className="server-menu__loading">loading...</p>
          ) : (() => {
            const stickerPacks = [...new Set(gifsList.filter(g => g.type === 'sticker' && g.pack_name).map(g => g.pack_name!))]
            return stickerPacks.length === 0 ? (
              <p className="server-menu__loading">no sticker packs uploaded yet</p>
            ) : stickerPacks.map(pack => {
              const packCount = gifsList.filter(g => g.type === 'sticker' && g.pack_name === pack).length
              return (
                <div key={pack} className="server-menu__gif-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', marginBottom: '4px' }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: '13px' }}>{pack}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '8px' }}>{packCount} sticker{packCount !== 1 ? 's' : ''}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <button
                      onClick={() => openStickerUpload(pack)}
                      className="server-menu__upload-btn"
                      style={{ padding: '4px 10px', fontSize: '11px' }}
                      title={`Add a sticker to ${pack}`}
                    >
                      + add
                    </button>
                    <button
                      onClick={() => handleDeleteStickerPack(pack)}
                      className="server-menu__gif-delete"
                      style={{ position: 'static' }}
                      title="Delete pack"
                    >
                      delete pack
                    </button>
                  </div>
                </div>
              )
            })
          })()}
        </>
      )}
    </div>

    {/* Styled popup for naming a sticker pack during .zip import (replaces window.prompt) */}
    <Modal
      open={packNameModal.open}
      onClose={() => setPackNameModal({ open: false, file: null, name: '' })}
      title="// name sticker pack"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            className="server-menu__confirm-cancel"
            onClick={() => setPackNameModal({ open: false, file: null, name: '' })}
            disabled={gifUploading}
          >
            cancel
          </button>
          <button
            className="server-menu__upload-btn"
            onClick={confirmStickerPackUpload}
            disabled={gifUploading || !packNameModal.name.trim()}
          >
            {gifUploading ? 'importing...' : 'import pack'}
          </button>
        </div>
      }
    >
      <label className="server-menu__label">pack name</label>
      <input
        autoFocus
        className="server-menu__input"
        placeholder="e.g. Summer Stickers"
        value={packNameModal.name}
        maxLength={100}
        onChange={(e) => setPackNameModal((s) => ({ ...s, name: e.target.value }))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && packNameModal.name.trim()) confirmStickerPackUpload()
        }}
      />
    </Modal>

    {/* Styled popup for uploading a single sticker into an existing or new pack */}
    {(() => {
      const existingPacks = [...new Set(gifsList.filter((g) => g.type === 'sticker' && g.pack_name).map((g) => g.pack_name!))]
      const resolvedPack = (stickerUpload.selectedPack || stickerUpload.newPackName).trim()
      const canSubmit = !!stickerUpload.file && !!resolvedPack && !stickerUpload.uploading
      return (
        <Modal
          open={stickerUpload.open}
          onClose={() => setStickerUpload((s) => ({ ...s, open: false }))}
          title="// add sticker"
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="server-menu__confirm-cancel"
                onClick={() => setStickerUpload((s) => ({ ...s, open: false }))}
                disabled={stickerUpload.uploading}
              >
                cancel
              </button>
              <button className="server-menu__upload-btn" onClick={confirmStickerUpload} disabled={!canSubmit}>
                {stickerUpload.uploading ? 'uploading...' : 'add sticker'}
              </button>
            </div>
          }
        >
          <label className="server-menu__label">sticker file</label>
          <div style={{ marginBottom: '12px' }}>
            <button className="server-menu__upload-btn" onClick={() => singleStickerFileRef.current?.click()}>
              {stickerUpload.file ? stickerUpload.file.name : 'choose .gif / .png / .webp'}
            </button>
            <input
              ref={singleStickerFileRef}
              type="file"
              accept=".gif,.png,.webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null
                setStickerUpload((s) => ({ ...s, file }))
                e.target.value = ''
              }}
            />
          </div>

          <label className="server-menu__label">pack</label>
          <select
            className="server-menu__select"
            value={stickerUpload.selectedPack}
            onChange={(e) => setStickerUpload((s) => ({ ...s, selectedPack: e.target.value }))}
            style={{ marginBottom: '8px' }}
          >
            <option value="">+ new pack…</option>
            {existingPacks.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {!stickerUpload.selectedPack && (
            <input
              className="server-menu__input"
              placeholder="new pack name"
              value={stickerUpload.newPackName}
              maxLength={100}
              onChange={(e) => setStickerUpload((s) => ({ ...s, newPackName: e.target.value }))}
              style={{ marginBottom: '12px' }}
            />
          )}

          <label className="server-menu__label">display name (optional)</label>
          <input
            className="server-menu__input"
            placeholder="defaults to file name"
            value={stickerUpload.displayName}
            maxLength={100}
            onChange={(e) => setStickerUpload((s) => ({ ...s, displayName: e.target.value }))}
          />
        </Modal>
      )
    })()}
    </>
  )
}
