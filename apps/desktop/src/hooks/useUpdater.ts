import { useCallback, useEffect } from 'react'
import { useSettingsStore, type PostUpdateNote } from '../store/settingsStore'
import { isTauri, isMobileTauri } from '../utils/platform'

const GITHUB_REPO = 'ItsAshn/kizuna'
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`

/** Delay the launch check so it never competes with connect/login for the network. */
const AUTO_CHECK_DELAY_MS = 8000

/**
 * Where the staged update leaves its release notes for the next launch to find.
 * Installing restarts the process, so this is the only way the new version can
 * report what changed.
 */
const PENDING_NOTE_KEY = 'kizuna-pending-update-note'

export { isMobileTauri }

type TauriUpdate = NonNullable<Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>>

/**
 * The handle returned by check() is what actually downloads the update, and the
 * download is now a separate user-initiated step. It outlives any one component,
 * so it's held here rather than in React state.
 */
let pendingUpdate: TauriUpdate | null = null

/**
 * Strips any leading `v`. Tag names, updater manifests and getVersion() don't
 * agree on the prefix, and these values get both compared and rendered.
 */
function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '')
}

/** Compares dotted numeric versions; returns true when `latest` is newer than `current`. */
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => normalizeVersion(v).split(/[.-]/).map((p) => parseInt(p, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

async function getAppVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app')
  return normalizeVersion(await getVersion())
}

function stashPendingNote(note: PostUpdateNote): void {
  try {
    localStorage.setItem(PENDING_NOTE_KEY, JSON.stringify(note))
  } catch {
    // Storage unavailable — the update still applies, just without the note.
  }
}

/**
 * Returns the stashed note only if the app is actually running the version it
 * was written for, so an abandoned or failed update never announces itself.
 */
async function consumePendingNote(): Promise<PostUpdateNote | null> {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(PENDING_NOTE_KEY)
  } catch {
    return null
  }
  if (!stored) return null

  try {
    const note = JSON.parse(stored) as PostUpdateNote
    const current = await getAppVersion()
    // Clear either way: a note for a version we never reached is stale.
    localStorage.removeItem(PENDING_NOTE_KEY)
    return normalizeVersion(note.version) === current ? note : null
  } catch {
    localStorage.removeItem(PENDING_NOTE_KEY)
    return null
  }
}

/**
 * Reports what changed if this launch is the first on a freshly installed
 * version, then checks for the next update. The check is silent by design: it
 * only surfaces UI when an update actually exists, so a normal start is
 * undisturbed.
 */
export function useUpdater(): void {
  const { checkForUpdates } = useUpdaterActions()
  const setPostUpdateNote = useSettingsStore((s) => s.setPostUpdateNote)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false

    void consumePendingNote().then((note) => {
      if (!cancelled && note) setPostUpdateNote(note)
    })

    const timer = setTimeout(() => {
      void checkForUpdates({ silent: true })
    }, AUTO_CHECK_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [checkForUpdates, setPostUpdateNote])
}

export function useUpdaterActions() {
  const setUpdateState = useSettingsStore((s) => s.setUpdateState)
  const setUpdateProgress = useSettingsStore((s) => s.setUpdateProgress)
  const setUpdateVersion = useSettingsStore((s) => s.setUpdateVersion)
  const setUpdateError = useSettingsStore((s) => s.setUpdateError)
  const setUpdateNotes = useSettingsStore((s) => s.setUpdateNotes)

  /**
   * Looks for a newer version. Never downloads — that's `downloadUpdate`, so the
   * user stays in control of when bandwidth gets spent.
   */
  const checkForUpdates = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      try {
        setUpdateState('checking')
        setUpdateError(null)

        if (isMobileTauri()) {
          // Mobile has no in-app installer; point at the release page instead.
          const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
          if (!res.ok) throw new Error('could not reach github releases')
          const release = await res.json()
          const latest = String(release.tag_name ?? '')

          if (!latest || !isNewer(latest, await getAppVersion())) {
            setUpdateState('upToDate')
            return { updateAvailable: false }
          }

          setUpdateVersion(normalizeVersion(latest))
          setUpdateNotes(typeof release.body === 'string' ? release.body : null)
          setUpdateState('available')
          return { updateAvailable: true }
        }

        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (!update) {
          pendingUpdate = null
          setUpdateNotes(null)
          setUpdateState('upToDate')
          return { updateAvailable: false }
        }

        pendingUpdate = update
        setUpdateVersion(normalizeVersion(update.version))
        setUpdateNotes(update.body ?? null)
        setUpdateState('available')
        return { updateAvailable: true }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        // A silent launch check that fails is not the user's problem — stay quiet
        // and let the next manual check report it.
        setUpdateState(silent ? 'idle' : 'error')
        setUpdateError(message)
        return { updateAvailable: false, error: message }
      }
    },
    [setUpdateState, setUpdateVersion, setUpdateError, setUpdateNotes],
  )

  /** Downloads and stages the pending update, reporting progress as a percentage. */
  const downloadUpdate = useCallback(async () => {
    if (isMobileTauri()) {
      window.open(RELEASES_URL, '_blank')
      return
    }
    if (!pendingUpdate) {
      // The handle is gone (e.g. a reload since the check) — re-check to get one.
      await checkForUpdates()
    }
    const update = pendingUpdate
    if (!update) return

    try {
      setUpdateState('downloading')
      setUpdateProgress(0)
      setUpdateError(null)

      let downloaded = 0
      let contentLength = 0
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0
            downloaded = 0
            break
          case 'Progress':
            downloaded += event.data.chunkLength
            if (contentLength > 0) {
              setUpdateProgress(Math.round((downloaded / contentLength) * 100))
            }
            break
          case 'Finished':
            setUpdateProgress(100)
            break
        }
      })
      // Hand the notes to the next launch before the restart wipes memory.
      stashPendingNote({ version: normalizeVersion(update.version), notes: update.body ?? null })
      setUpdateState('ready')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setUpdateState('error')
      setUpdateError(message)
    }
  }, [checkForUpdates, setUpdateState, setUpdateProgress, setUpdateError])

  /** Restarts into the freshly staged version. */
  const installUpdate = useCallback(async () => {
    if (isMobileTauri()) {
      window.open(RELEASES_URL, '_blank')
      return
    }
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch {
      // relaunch unavailable — the update still applies on the next manual start
    }
  }, [])

  const getVersion = useCallback(async () => {
    try {
      return await getAppVersion()
    } catch {
      return null
    }
  }, [])

  return { checkForUpdates, downloadUpdate, installUpdate, getVersion }
}
