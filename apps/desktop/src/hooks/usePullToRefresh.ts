import { useRef, useCallback, useState } from 'react'

interface PullToRefreshOptions {
  onRefresh: () => Promise<void> | void
  threshold?: number
  disabled?: boolean
}

interface PullToRefreshState {
  pulling: boolean
  refreshing: boolean
  pullDistance: number
  indicatorOpacity: number
}

const PULL_THRESHOLD = 64
const MAX_PULL = 120
const SPRING_TENSION = 180
const SPRING_FRICTION = 20

export function usePullToRefresh({
  onRefresh,
  threshold = PULL_THRESHOLD,
  disabled = false,
}: PullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>({
    pulling: false,
    refreshing: false,
    pullDistance: 0,
    indicatorOpacity: 0,
  })

  const startY = useRef(0)
  const currentY = useRef(0)
  const pulling = useRef(false)
  const scrollEl = useRef<HTMLElement | null>(null)
  const animFrame = useRef<number>(0)
  const velocity = useRef(0)
  const lastY = useRef(0)
  const lastTime = useRef(0)

  const animateSpring = useCallback((fromDistance: number) => {
    let d = fromDistance
    let v = velocity.current

    function step() {
      const force = -SPRING_TENSION * d
      const damping = SPRING_FRICTION * v
      const acceleration = (force - damping) / 1
      v += acceleration * (1 / 60)
      d += v * (1 / 60)

      if (Math.abs(d) < 0.5 && Math.abs(v) < 1) {
        setState((s) => ({ ...s, pulling: false, pullDistance: 0, indicatorOpacity: 0 }))
        return
      }

      setState((s) => ({
        ...s,
        pullDistance: Math.max(0, d),
        indicatorOpacity: Math.max(0, Math.min(1, d / threshold)),
      }))
      animFrame.current = requestAnimationFrame(step)
    }

    animFrame.current = requestAnimationFrame(step)
  }, [threshold])

  const containerRef = useCallback(
    (el: HTMLElement | null) => {
      scrollEl.current = el
      if (!el || disabled) return
      const target = el

    function handleTouchStart(e: TouchEvent) {
      if (disabled || state.refreshing) return
      // Only trigger pull when at the very top of the scroll
      if (target.scrollTop > 2) return
      if (e.touches.length !== 1) return

      const touch = e.touches[0]
      startY.current = touch.clientY
      currentY.current = touch.clientY
      lastY.current = touch.clientY
      lastTime.current = Date.now()
      pulling.current = false
    }

    function handleTouchMove(e: TouchEvent) {
      if (disabled || state.refreshing) return
      if (e.touches.length !== 1) return

      const touch = e.touches[0]
      currentY.current = touch.clientY

      const dy = touch.clientY - startY.current
      if (dy > 5 && !pulling.current && target.scrollTop <= 0) {
        pulling.current = true
      }
      if (!pulling.current) return

      const now = Date.now()
      const dt = now - lastTime.current
      if (dt > 0) {
        velocity.current = (touch.clientY - lastY.current) / dt * 16
      }
      lastY.current = touch.clientY
      lastTime.current = now

      if (dy > 5) {
        e.preventDefault()
      }

      // Rubber-band damping: resistance increases as pull grows
      const damped = Math.min(dy * 0.5, MAX_PULL)
      setState({
        pulling: true,
        refreshing: false,
        pullDistance: damped,
        indicatorOpacity: Math.min(1, damped / threshold),
      })
    }

    function handleTouchEnd() {
      if (!pulling.current) return
      pulling.current = false

      if (state.pullDistance >= threshold && !state.refreshing) {
        setState((s) => ({ ...s, pulling: false, refreshing: true, pullDistance: threshold, indicatorOpacity: 1 }))
        const result = onRefresh()
        if (result instanceof Promise) {
          result.finally(() => {
            animateSpring(threshold)
            setState((s) => ({ ...s, refreshing: false }))
          })
        } else {
          setState((s) => ({ ...s, refreshing: false }))
          animateSpring(threshold)
        }
      } else {
        animateSpring(state.pullDistance)
      }
    }

      target.addEventListener('touchstart', handleTouchStart, { passive: false })
      target.addEventListener('touchmove', handleTouchMove, { passive: false })
      target.addEventListener('touchend', handleTouchEnd)

      return () => {
        target.removeEventListener('touchstart', handleTouchStart)
        target.removeEventListener('touchmove', handleTouchMove)
        target.removeEventListener('touchend', handleTouchEnd)
        if (animFrame.current) cancelAnimationFrame(animFrame.current)
      }
    },
    [disabled, state.refreshing, state.pullDistance, threshold, onRefresh, animateSpring],
  )

  return {
    ...state,
    containerRef,
    indicatorHeight: state.pullDistance,
  }
}
