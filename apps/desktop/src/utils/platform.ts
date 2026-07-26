export function isTauri(): boolean {
  return !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

export function isMobileTauri(): boolean {
  if (!isTauri()) return false
  const ua = navigator.userAgent || ''
  return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua)
}

/**
 * Desktop Linux runs in a WebKitGTK webview, which has no WebRTC stack of its
 * own — screensharing there is captured, encoded and sent by Rust instead.
 */
export function isLinuxDesktop(): boolean {
  if (!isTauri() || isMobileTauri()) return false
  return /linux|x11/i.test(navigator.userAgent || '')
}
