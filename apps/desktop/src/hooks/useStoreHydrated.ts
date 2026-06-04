import { useEffect, useState } from 'react'
import { useServerStore } from '../store/serverStore'

export function useStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() =>
    useServerStore.persist.hasHydrated(),
  )
  useEffect(() => {
    if (hydrated) return
    const unsub = useServerStore.persist.onFinishHydration(() => setHydrated(true))
    if (useServerStore.persist.hasHydrated()) setHydrated(true)
    return unsub
  }, [hydrated])
  return hydrated
}
