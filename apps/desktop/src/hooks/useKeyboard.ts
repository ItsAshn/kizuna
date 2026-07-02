import { useEffect } from 'react'

export function useKeyboard() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    let prevHeight = 0

    function update() {
      const keyboardHeight = Math.max(0, window.innerHeight - vv!.height)
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`)
      // Attribute hook for CSS that can't read the custom property's value
      // (e.g. collapsing the bottom tab bar while the keyboard is up).
      document.documentElement.toggleAttribute('data-keyboard-open', keyboardHeight > 100)

      // When the keyboard opens, keep the focused field visible above it.
      // Fixed-position composers stay put on their own; this mainly rescues
      // inputs inside scrollable sheets/forms that the keyboard would cover.
      if (keyboardHeight > 100 && keyboardHeight > prevHeight + 20) {
        const el = document.activeElement as HTMLElement | null
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }))
        }
      }
      prevHeight = keyboardHeight
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--keyboard-height')
      document.documentElement.removeAttribute('data-keyboard-open')
    }
  }, [])
}
