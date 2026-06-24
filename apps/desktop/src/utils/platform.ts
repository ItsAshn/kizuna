export function isTauri(): boolean {
  return !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

export function isMobileTauri(): boolean {
  if (!isTauri()) return false
  const ua = navigator.userAgent || ''
  return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua)
}
