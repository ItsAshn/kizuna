import { flushSync } from 'react-dom'

/* Mobile navigation transitions via the View Transitions API.
 *
 * The mobile shell mounts a single view at a time, so a plain React commit
 * makes the outgoing screen vanish in the same frame the new one appears —
 * there is nothing to animate against. startViewTransition() solves this at
 * the platform level: it snapshots the outgoing view, applies the DOM update,
 * and then lets CSS animate old and new snapshots together like a native
 * navigation controller (see MobileShell.css for the choreography).
 *
 * The direction travels on <html data-nav-transition="push|pop|tab"> for the
 * duration of the transition, because the ::view-transition pseudo-elements
 * can only be selected from the document root.
 *
 * WebViews without the API (WebKitGTK, iOS < 18) fall back to the mount
 * animations in MobileShell.css — callers gate those on supportsNavTransitions.
 */

export type NavDirection = 'push' | 'pop' | 'tab'

type StartViewTransition = (update: () => void) => { finished: Promise<void> }

const startViewTransition: StartViewTransition | undefined =
  typeof document !== 'undefined'
    ? (
        document as unknown as { startViewTransition?: StartViewTransition }
      ).startViewTransition?.bind(document)
    : undefined

export const supportsNavTransitions = typeof startViewTransition === 'function'

/* Rapid navigations skip the in-flight transition (per spec); the sequence
 * counter keeps a stale finished-handler from clearing a newer direction. */
let transitionSeq = 0

export function runNavTransition(direction: NavDirection, commit: () => void) {
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!startViewTransition || reducedMotion) {
    commit()
    return
  }

  const seq = ++transitionSeq
  document.documentElement.dataset.navTransition = direction

  /* React renders asynchronously, but startViewTransition captures the "new"
   * state as soon as its callback resolves — flushSync forces the commit to
   * land inside that window. */
  const transition = startViewTransition(() => {
    flushSync(commit)
  })

  transition.finished
    .catch(() => {})
    .finally(() => {
      if (seq === transitionSeq) {
        delete document.documentElement.dataset.navTransition
      }
    })
}
