import { useEffect } from 'react'

export function useKeyboard() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function update() {
      const keyboardHeight = Math.max(0, window.innerHeight - vv!.height)
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--keyboard-height')
    }
  }, [])
}
