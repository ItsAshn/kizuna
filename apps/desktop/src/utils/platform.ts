export function isTauri(): boolean {
  return !!(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
}

/**
 * Chat links must never navigate the app's own webview — there's no back
 * button, so it strands the user away from the client. Route them to the
 * OS default browser instead.
 */
export async function openExternalLink(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export function isMobileTauri(): boolean {
  if (!isTauri()) return false
  const ua = navigator.userAgent || ''
  return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua)
}

/**
 * Android's WebView has no getDisplayMedia and the native capture commands
 * are desktop-only, so the mobile app can watch a screenshare but not send one.
 */
export const MOBILE_SCREENSHARE_UNSUPPORTED =
  "Screen sharing isn't available in the mobile app. You can still watch someone else's share."

/**
 * Desktop Linux runs in a WebKitGTK webview, which has no WebRTC stack of its
 * own — screensharing there is captured, encoded and sent by Rust instead.
 */
export function isLinuxDesktop(): boolean {
  if (!isTauri() || isMobileTauri()) return false
  return /linux|x11/i.test(navigator.userAgent || '')
}
