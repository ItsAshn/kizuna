import { useCallback } from 'react'

const hasVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator

const PATTERNS: Record<string, number | number[]> = {
  light: 5,
  medium: 10,
  strong: 15,
  tap: 8,
  longPress: 12,
  success: [10, 30, 10],
  error: [30, 50, 30],
  select: [5, 30, 5],
  swipe: 8,
}

type HapticName = keyof typeof PATTERNS

export function useHaptics() {
  const vibrate = useCallback((pattern: HapticName | number | number[]) => {
    if (!hasVibrate) return
    try {
      const p = typeof pattern === 'string' ? PATTERNS[pattern] : pattern
      if (p !== undefined) navigator.vibrate(p)
    } catch {}
  }, [])

  const light = useCallback(() => vibrate('light'), [vibrate])
  const medium = useCallback(() => vibrate('medium'), [vibrate])
  const strong = useCallback(() => vibrate('strong'), [vibrate])
  const tap = useCallback(() => vibrate('tap'), [vibrate])
  const longPress = useCallback(() => vibrate('longPress'), [vibrate])
  const success = useCallback(() => vibrate('success'), [vibrate])
  const error = useCallback(() => vibrate('error'), [vibrate])
  const select = useCallback(() => vibrate('select'), [vibrate])
  const swipe = useCallback(() => vibrate('swipe'), [vibrate])

  return { vibrate, light, medium, strong, tap, longPress, success, error, select, swipe }
}
