import { useSyncExternalStore } from 'react'

/**
 * Resolves a CSS colour token (e.g. `--brand`) to a concrete colour string for
 * APIs that can't read custom properties, like a canvas `fillStyle` (which
 * silently ignores `var(--brand)`).
 *
 * Resolved through a probe element rather than reading the property off
 * :root: tokens are often `color-mix(...)` or `var(...)` chains, which only
 * the cascade evaluates, and a server theme may override a token on a nested
 * element. Resolving inside `scope` honours both.
 */
export function resolveTokenColor(scope: Element | null, token: string, fallback = ''): string {
  const host = scope ?? document.documentElement
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.color = `var(${token})`
  host.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color || fallback
}

/* Theme changes arrive as <style> elements (server custom CSS, its live
 * preview) being added, removed or edited in <head>, or inline custom
 * properties set on <html>. There is no app event for it, so watch for those
 * mutations and expose a counter that bumps on each one. */
let themeVersion = 0
const listeners = new Set<() => void>()
let observer: MutationObserver | null = null

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      themeVersion++
      listeners.forEach((l) => l())
    })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = null
    }
  }
}

/** A number that changes whenever the theme may have changed. */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, () => themeVersion)
}
