import { useEffect } from 'react'

export function useKeyboard() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function update() {
      const keyboardHeight = Math.max(0, window.innerHeight - vv!.height)
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`)
      document.documentElement.style.setProperty('--keyboard-padding', `${Math.max(keyboardHeight, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('env(safe-area-inset-bottom)').replace('px', '')) || 0)}px`)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--keyboard-height')
      document.documentElement.style.removeProperty('--keyboard-padding')
    }
  }, [])
}
