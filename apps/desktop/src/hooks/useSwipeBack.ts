import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useHaptics } from './useHaptics'

/* iOS-style interactive back gesture for the mobile navigation shell: a drag
 * starting at the left screen edge makes the current nav view follow the
 * finger; releasing past a distance or velocity threshold commits the pop,
 * otherwise the view springs back.
 *
 * This is shell-level by design — individual screens (Sidebar, ChatArea, the
 * voice stage) don't own "back"; the navigation stack does, so every pushed
 * view gets the same gesture for free.
 *
 * On commit the view is animated fully off-screen *before* the pop runs; the
 * pop's view transition then only settles the revealed view in from its
 * parallax offset, so the two motions compose without a jump (the old
 * implementation snapped the dragged view to x=0 first, which flashed).
 *
 * Listeners live on the stable container, not the keyed view element, so
 * they survive remounts; the view is resolved per gesture. On Android with
 * gesture navigation the system owns the screen edges and these touches
 * never reach us — the hardware back path covers that platform. */

interface SwipeBackOptions {
  /** Stable container that hosts the keyed `.mobile-content__view`. */
  containerRef: RefObject<HTMLElement | null>
  /** Whether a gesture may begin (e.g. nav stack non-empty). */
  canSwipe: () => boolean
  /** Perform the pop once the view has left the screen. */
  onCommit: () => void
}

const EDGE_ZONE_PX = 32
const INTENT_SLOP_PX = 8
const COMMIT_FRACTION = 0.35
const COMMIT_VELOCITY = 0.45 // px/ms

export function useSwipeBack({ containerRef, canSwipe, onCommit }: SwipeBackOptions) {
  const haptics = useHaptics()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let view: HTMLElement | null = null
    let tracking = false
    let active = false
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastTime = 0
    let velocityX = 0
    let width = 1

    const resolveView = () =>
      container.querySelector<HTMLElement>(':scope > .mobile-content__view')

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1 || !canSwipe()) return
      const touch = e.touches[0]
      if (touch.clientX > EDGE_ZONE_PX) return
      view = resolveView()
      if (!view) return
      tracking = true
      active = false
      startX = touch.clientX
      startY = touch.clientY
      lastX = touch.clientX
      lastTime = e.timeStamp
      velocityX = 0
      width = container!.clientWidth || 1
    }

    function onTouchMove(e: TouchEvent) {
      if (!tracking || !view) return
      const touch = e.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY

      if (!active) {
        // Direction lock: a mostly-vertical start is a scroll, not a swipe.
        if (Math.abs(dy) > INTENT_SLOP_PX && Math.abs(dy) > Math.abs(dx)) {
          tracking = false
          view = null
          return
        }
        if (dx < INTENT_SLOP_PX || Math.abs(dx) <= Math.abs(dy)) return
        active = true
        view.style.willChange = 'transform'
        view.classList.add('mobile-content__view--dragging')
        haptics.light()
      }

      e.preventDefault()
      const dt = e.timeStamp - lastTime
      if (dt > 0) velocityX = (touch.clientX - lastX) / dt
      lastX = touch.clientX
      lastTime = e.timeStamp
      view.style.transform = `translateX(${Math.max(0, dx)}px)`
    }

    function settle(commit: boolean, fromX: number) {
      const el = view
      tracking = false
      active = false
      view = null
      if (!el) return

      const remaining = commit ? width - fromX : fromX
      const duration = Math.min(
        320,
        Math.max(120, remaining / Math.max(Math.abs(velocityX), 0.6)),
      )
      const animation = el.animate(
        [
          { transform: `translateX(${fromX}px)` },
          { transform: `translateX(${commit ? width : 0}px)` },
        ],
        {
          duration,
          easing: commit
            ? 'cubic-bezier(0.2, 0.8, 0.4, 1)'
            : 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'forwards',
        },
      )
      animation.onfinish = () => {
        if (commit) {
          // The element is off-screen and about to be unmounted by the pop;
          // keep the fill so it never flashes back at x=0.
          onCommit()
          return
        }
        animation.cancel()
        el.classList.remove('mobile-content__view--dragging')
        el.style.transform = ''
        el.style.willChange = ''
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (!tracking || !view) return
      if (!active) {
        tracking = false
        view = null
        return
      }
      const endX = e.changedTouches[0]?.clientX ?? startX
      const dx = Math.max(0, endX - startX)
      const commit = dx > width * COMMIT_FRACTION || velocityX > COMMIT_VELOCITY
      if (commit) haptics.swipe()
      settle(commit, dx)
    }

    function onTouchCancel() {
      if (!tracking || !view) return
      if (!active) {
        tracking = false
        view = null
        return
      }
      settle(false, Math.max(0, lastX - startX))
    }

    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('touchend', onTouchEnd)
    container.addEventListener('touchcancel', onTouchCancel)
    return () => {
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('touchend', onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [containerRef, canSwipe, onCommit, haptics])
}
