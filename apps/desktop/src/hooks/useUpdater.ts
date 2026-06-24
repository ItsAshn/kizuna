import { useCallback } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { isMobileTauri } from '../utils/platform'

const GITHUB_REPO = 'ItsAshn/kizuna'

export { isMobileTauri }

export function useUpdater(): void {
  // Tauri updater events are handled via check() / downloadAndInstall()
  // No global event listener needed — state is managed through useUpdaterActions
}

export function useUpdaterActions() {
  const setUpdateState = useSettingsStore((s) => s.setUpdateState)
  const setUpdateProgress = useSettingsStore((s) => s.setUpdateProgress)
  const setUpdateVersion = useSettingsStore((s) => s.setUpdateVersion)
  const setUpdateError = useSettingsStore((s) => s.setUpdateError)

  const checkForUpdates = useCallback(async () => {
    try {
      setUpdateState('checking')
      setUpdateError(null)

      if (isMobileTauri()) {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`)
        if (!res.ok) throw new Error('failed to check for updates')
        const release = await res.json()
        const latestTag = release.tag_name.replace(/^v/, '')

        const { getVersion } = await import('@tauri-apps/api/app')
        const currentVersion = await getVersion()

        if (latestTag === currentVersion) {
          setUpdateState('idle')
          return { updateAvailable: false }
        }

        setUpdateVersion(release.tag_name)
        setUpdateState('ready')
        return { updateAvailable: true }
      }

      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (!update) {
        setUpdateState('idle')
        return { updateAvailable: false }
      }
      setUpdateState('downloading')
      setUpdateVersion(update.version)
      setUpdateProgress(0)
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
            setUpdateState('ready')
            setUpdateProgress(100)
            break
        }
      })
      return { updateAvailable: true }
    } catch (err: unknown) {
      const e = err as Error | { message?: string }
      setUpdateState('error')
      setUpdateError(e.message || String(err))
      return { updateAvailable: false, error: e.message }
    }
  }, [setUpdateState, setUpdateProgress, setUpdateVersion, setUpdateError])

  const installUpdate = useCallback(async () => {
    if (isMobileTauri()) {
      window.open(`https://github.com/${GITHUB_REPO}/releases/latest`, '_blank')
      return
    }

    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch {
      // relaunch not available — user restarts manually
    }
  }, [])

  const getVersion = useCallback(async () => {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      return await getVersion()
    } catch {
      return '0.1.0'
    }
  }, [])

  return { checkForUpdates, installUpdate, getVersion }
}
