import { useEffect, useCallback } from 'react'
import { useChatStore } from '../store/chatStore'

export function useUpdater(): void {
  // Tauri updater events are handled via check() / downloadAndInstall()
  // No global event listener needed — state is managed through useUpdaterActions
}

export function useUpdaterActions() {
  const setUpdateState = useChatStore((s) => s.setUpdateState)
  const setUpdateProgress = useChatStore((s) => s.setUpdateProgress)
  const setUpdateVersion = useChatStore((s) => s.setUpdateVersion)
  const setUpdateError = useChatStore((s) => s.setUpdateError)

  const checkForUpdates = useCallback(async () => {
    try {
      setUpdateState('checking')
      setUpdateError(null)
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
    } catch (err: any) {
      setUpdateState('error')
      setUpdateError(err.message || String(err))
      return { updateAvailable: false, error: err.message }
    }
  }, [setUpdateState, setUpdateProgress, setUpdateVersion, setUpdateError])

  const installUpdate = useCallback(async () => {
    // Update is already downloaded and installed by downloadAndInstall()
    // Relaunch the app to apply the update
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
