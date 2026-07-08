import { useEffect, useState, useCallback } from 'react'
import { useServerStore } from '../../store/serverStore'
import {
  fetchStorageStats,
  clearAuditLogs,
  cleanupOrphanFiles,
} from '@kizuna/shared'

import { handleApiErr } from './common'

export function LogsSection() {
  const session = useServerStore((s) => s.activeSession)
  const [stats, setStats] = useState<{ attachments: { count: number; totalSize: number }; gifs: { count: number; totalSize: number }; auditLogs: { count: number }; orphans: { count: number; totalSize: number }; dbSize: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionMsg, setActionMsg] = useState('')
  const [clearConfirm, setClearConfirm] = useState(false)
  const [orphanConfirm, setOrphanConfirm] = useState(false)

  const loadStats = useCallback(async () => {
    if (!session) return
    try {
      const s = await fetchStorageStats(session.url)
      setStats(s)
    } catch {} finally {
      setLoading(false)
    }
  }, [session])

  useEffect(() => { loadStats() }, [loadStats])

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const handleClearAudit = async () => {
    if (!session) return
    setActionMsg('')
    try {
      await clearAuditLogs(session.url)
      setActionMsg('audit logs cleared')
      setClearConfirm(false)
      loadStats()
    } catch (err) {
      setActionMsg(`error: ${handleApiErr(err)}`)
    }
  }

  const handleCleanupOrphans = async () => {
    if (!session) return
    setActionMsg('')
    try {
      const res = await cleanupOrphanFiles(session.url)
      setActionMsg(`deleted ${res.deletedCount} orphan files (${formatBytes(res.freedBytes)})`)
      setOrphanConfirm(false)
      loadStats()
    } catch (err) {
      setActionMsg(`error: ${handleApiErr(err)}`)
    }
  }

  if (loading) return <p className="server-menu__loading">loading...</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <h3 style={{ margin: 0 }}>logs & data</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: 0 }}>
        Manage server storage and audit logs. Auto-cleanup runs every 6 hours for orphan files and daily for old audit logs.
      </p>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Attachments</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.attachments.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{formatBytes(stats.attachments.totalSize)}</div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>GIFs & Stickers</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.gifs.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{formatBytes(stats.gifs.totalSize)}</div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Audit Logs</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.auditLogs.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>entries</div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Orphaned Files</div>
            <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '2px' }}>{stats.orphans.count}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{formatBytes(stats.orphans.totalSize)}</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
          <span style={{ flex: 1, fontSize: '13px' }}>Clear audit logs ({stats?.auditLogs.count ?? 0} entries)</span>
          {clearConfirm ? (
            <>
              <button className="server-menu__btn server-menu__btn--danger" onClick={handleClearAudit} style={{ padding: '4px 10px', fontSize: '12px' }}>confirm</button>
              <button className="server-menu__btn" onClick={() => setClearConfirm(false)} style={{ padding: '4px 10px', fontSize: '12px' }}>cancel</button>
            </>
          ) : (
            <button className="server-menu__btn server-menu__btn--danger" onClick={() => setClearConfirm(true)} style={{ padding: '4px 10px', fontSize: '12px' }}>clear</button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
          <span style={{ flex: 1, fontSize: '13px' }}>Clean up orphaned files ({stats?.orphans.count ?? 0} files, {stats ? formatBytes(stats.orphans.totalSize) : '0 B'})</span>
          {orphanConfirm ? (
            <>
              <button className="server-menu__btn server-menu__btn--danger" onClick={handleCleanupOrphans} style={{ padding: '4px 10px', fontSize: '12px' }}>confirm</button>
              <button className="server-menu__btn" onClick={() => setOrphanConfirm(false)} style={{ padding: '4px 10px', fontSize: '12px' }}>cancel</button>
            </>
          ) : (
            <button className="server-menu__btn server-menu__btn--danger" onClick={() => setOrphanConfirm(true)} style={{ padding: '4px 10px', fontSize: '12px' }}>clean up</button>
          )}
        </div>
      </div>

      {actionMsg && (
        <p style={{ color: actionMsg.startsWith('error') ? 'var(--error)' : 'var(--success)', fontSize: '13px' }}>{actionMsg}</p>
      )}

      {stats && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Database size: {formatBytes(stats.dbSize)}
        </div>
      )}
    </div>
  )
}

