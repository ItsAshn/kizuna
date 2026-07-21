/** Notes longer than this are truncated — the release page has the full text. */
const MAX_LINES = 8

export interface ReleaseNotes {
  lines: string[]
  /** True when lines were dropped, so callers can point at the full notes. */
  truncated: boolean
}

/**
 * Reduces a GitHub release body to plain bullet lines. Release notes are
 * markdown, but the update surfaces only ever need a short skimmable list, so
 * this strips the markup rather than pulling in a renderer.
 */
export function parseReleaseNotes(body: string | null | undefined): ReleaseNotes {
  if (!body) return { lines: [], truncated: false }

  const lines = body
    .split('\n')
    .map((line) => line.trim())
    // Drop headings, horizontal rules, blockquotes and the changelog compare
    // link GitHub appends to generated notes.
    .filter((line) => line && !/^(#{1,6}\s|[-*_]{3,}$|>)/.test(line))
    .filter((line) => !/^\*\*full changelog\*\*/i.test(line))
    .map((line) =>
      line
        .replace(/^[-*+]\s+/, '') // list markers
        .replace(/^\d+\.\s+/, '') // ordered list markers
        .replace(/\*\*(.+?)\*\*/g, '$1') // bold
        .replace(/`(.+?)`/g, '$1') // inline code
        .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links → their text
        .replace(/\s+by\s+@[\w-]+\s+in\s+https?:\/\/\S+$/i, '') // PR attribution
        .trim(),
    )
    .filter(Boolean)

  return { lines: lines.slice(0, MAX_LINES), truncated: lines.length > MAX_LINES }
}
