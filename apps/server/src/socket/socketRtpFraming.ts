/** Socket RTP framings this server can emit, best first. */
const SERVER_FRAMINGS = [2, 1] as const

/**
 * Pick the socket RTP framing for a `voice:enableSocketRtp` request.
 *
 * Current clients advertise every framing they can parse (`supported`), and
 * the server picks the best one it also speaks. Clients from before that field
 * sent a single `framing` (2 meaning "2, or 1 if you must"), and the oldest
 * sent nothing at all.
 */
export function chooseSocketRtpFraming(opts: unknown): number {
  const rec = opts !== null && typeof opts === 'object' ? (opts as Record<string, unknown>) : null
  const supported = rec?.supported
  if (Array.isArray(supported)) {
    for (const f of SERVER_FRAMINGS) {
      if (supported.includes(f)) return f
    }
    return 1
  }
  const requested = rec?.framing
  return typeof requested === 'number' && requested >= 2 ? 2 : 1
}
