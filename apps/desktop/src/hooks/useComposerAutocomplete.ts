import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { ChatCommand } from '@kizuna/shared'
import { CHAT_COMMANDS } from '@kizuna/shared'
import { userCanUseCommand } from '../lib/chatCommands'
import type { CommandUser } from '../lib/chatCommands'

export const MENTION_LIMIT = 8

export const EMOJI_LIST: { shortcode: string; emoji: string }[] = [
  { shortcode: 'smile', emoji: '😊' },
  { shortcode: 'laugh', emoji: '😂' },
  { shortcode: 'heart', emoji: '❤️' },
  { shortcode: 'thumbsup', emoji: '👍' },
  { shortcode: 'thumbsdown', emoji: '👎' },
  { shortcode: 'clap', emoji: '👏' },
  { shortcode: 'fire', emoji: '🔥' },
  { shortcode: 'star', emoji: '⭐' },
  { shortcode: 'check', emoji: '✅' },
  { shortcode: 'x', emoji: '❌' },
  { shortcode: 'warning', emoji: '⚠️' },
  { shortcode: 'question', emoji: '❓' },
  { shortcode: 'bulb', emoji: '💡' },
  { shortcode: 'rocket', emoji: '🚀' },
  { shortcode: 'party', emoji: '🎉' },
  { shortcode: 'cry', emoji: '😢' },
  { shortcode: 'angry', emoji: '😠' },
  { shortcode: 'cool', emoji: '😎' },
  { shortcode: 'wink', emoji: '😉' },
  { shortcode: 'kiss', emoji: '😘' },
  { shortcode: 'hug', emoji: '🤗' },
  { shortcode: 'pray', emoji: '🙏' },
  { shortcode: 'ok', emoji: '👌' },
  { shortcode: 'wave', emoji: '👋' },
  { shortcode: 'muscle', emoji: '💪' },
  { shortcode: 'brain', emoji: '🧠' },
  { shortcode: 'eyes', emoji: '👀' },
  { shortcode: '100', emoji: '💯' },
  { shortcode: 'tada', emoji: '🎊' },
  { shortcode: 'sunglasses', emoji: '😎' },
  { shortcode: 'sleep', emoji: '😴' },
  { shortcode: 'cat', emoji: '🐱' },
  { shortcode: 'dog', emoji: '🐶' },
  { shortcode: 'alien', emoji: '👽' },
  { shortcode: 'ghost', emoji: '👻' },
  { shortcode: 'skull', emoji: '💀' },
  { shortcode: 'pizza', emoji: '🍕' },
  { shortcode: 'coffee', emoji: '☕' },
  { shortcode: 'beer', emoji: '🍺' },
  { shortcode: 'crown', emoji: '👑' },
  { shortcode: 'gem', emoji: '💎' },
  { shortcode: 'gift', emoji: '🎁' },
  { shortcode: 'zap', emoji: '⚡' },
  { shortcode: 'rainbow', emoji: '🌈' },
  { shortcode: 'lock', emoji: '🔒' },
  { shortcode: 'key', emoji: '🔑' },
  { shortcode: 'hammer', emoji: '🔨' },
  { shortcode: 'wrench', emoji: '🔧' },
  { shortcode: 'link', emoji: '🔗' },
  { shortcode: 'pin', emoji: '📌' },
  { shortcode: 'book', emoji: '📖' },
  { shortcode: 'pencil', emoji: '✏️' },
  { shortcode: 'scissors', emoji: '✂️' },
  { shortcode: 'phone', emoji: '📱' },
  { shortcode: 'monitor', emoji: '🖥️' },
  { shortcode: 'mute', emoji: '🔇' },
  { shortcode: 'sound', emoji: '🔊' },
]

function getAtQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor)
  const match = /(?:^|[\s])@([\w.-]*)$/.exec(before)
  return match ? match[1] : null
}

function getEmojiQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor)
  const match = /(?:^|[\s]):([\w+-]*)$/.exec(before)
  return match ? match[1] : null
}

interface UseComposerAutocompleteArgs {
  input: string
  setInput: (value: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** Ordered mention candidates: special targets, role names, usernames. */
  mentionCandidates: string[]
  /** Current user, for filtering slash commands by permission. */
  user: CommandUser | null
  /** Slash suggestions only make sense with an active channel. */
  slashEnabled: boolean
}

/**
 * Owns the @mention / :emoji: / slash-command autocomplete state for the
 * message composer: query extraction on input, keyboard navigation, and
 * inserting the picked suggestion back into the textarea.
 */
export function useComposerAutocomplete({
  input,
  setInput,
  inputRef,
  mentionCandidates,
  user,
  slashEnabled,
}: UseComposerAutocompleteArgs) {
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const [emojiIndex, setEmojiIndex] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedEmojiIndex, setSelectedEmojiIndex] = useState(0)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([])

  const suggestions =
    atQuery !== null
      ? mentionCandidates.filter((u) => u.toLowerCase().startsWith(atQuery.toLowerCase()))
      : []

  const emojiSuggestions =
    emojiQuery !== null
      ? EMOJI_LIST.filter((e) =>
          e.shortcode.toLowerCase().startsWith(emojiQuery.toLowerCase()),
        ).slice(0, 8)
      : []

  const slashSuggestions = useMemo<ChatCommand[]>(() => {
    if (slashQuery === null || !user) return []
    const q = slashQuery.toLowerCase()
    return CHAT_COMMANDS.filter(
      (c) =>
        (c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))) &&
        userCanUseCommand(user, c),
    )
  }, [slashQuery, user])

  useEffect(() => {
    setSelectedIndex(0)
  }, [suggestions.length, atQuery])
  useEffect(() => {
    setSelectedEmojiIndex(0)
  }, [emojiSuggestions.length, emojiQuery])
  useEffect(() => {
    suggestionRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  /** Re-extract queries after the composer text or cursor changed. */
  const onInputChange = useCallback(
    (val: string, cursor: number) => {
      const query = getAtQuery(val, cursor)
      const emQuery = getEmojiQuery(val, cursor)
      setAtQuery(query)
      setEmojiQuery(emQuery)

      const slash =
        slashEnabled && val.startsWith('/') && !val.slice(1).includes(' ') ? val.slice(1) : null
      setSlashQuery(slash)
      if (slash !== null) setSelectedSlashIndex(0)
      if (query !== null) {
        setAtIndex(val.slice(0, cursor).lastIndexOf('@'))
      }
      if (emQuery !== null) {
        setEmojiIndex(val.slice(0, cursor).lastIndexOf(':'))
      }
    },
    [slashEnabled],
  )

  const insertMention = (username: string) => {
    const before = input.slice(0, atIndex)
    const after = input.slice(atIndex + 1 + (atQuery?.length ?? 0))
    setInput(`${before}@${username} ${after}`)
    setAtQuery(null)
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + username.length + 2
        inputRef.current.setSelectionRange(pos, pos)
        inputRef.current.focus()
      }
    })
  }

  const insertEmoji = (entry: (typeof EMOJI_LIST)[0]) => {
    const before = input.slice(0, emojiIndex)
    const after = input.slice(emojiIndex + 1 + (emojiQuery?.length ?? 0))
    setInput(`${before}${entry.emoji} ${after}`)
    setEmojiQuery(null)
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + entry.emoji.length + 1
        inputRef.current.setSelectionRange(pos, pos)
        inputRef.current.focus()
      }
    })
  }

  const insertSlashCommand = (cmd: ChatCommand) => {
    setInput(`/${cmd.name} `)
    setSlashQuery(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  /** Returns true when the key event was consumed by an open suggestion list. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedSlashIndex((i) => (i + 1) % slashSuggestions.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length)
        return true
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        insertSlashCommand(slashSuggestions[selectedSlashIndex] ?? slashSuggestions[0])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashQuery(null)
        return true
      }
    }
    if (emojiSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedEmojiIndex((i) => (i + 1) % emojiSuggestions.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedEmojiIndex((i) => (i - 1 + emojiSuggestions.length) % emojiSuggestions.length)
        return true
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        insertEmoji(emojiSuggestions[selectedEmojiIndex] ?? emojiSuggestions[0])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setEmojiQuery(null)
        return true
      }
    }
    if (suggestions.length > 0) {
      const visible = suggestions.slice(0, MENTION_LIMIT).length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % visible)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + visible) % visible)
        return true
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        insertMention(suggestions[selectedIndex] ?? suggestions[0])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtQuery(null)
        return true
      }
    }
    return false
  }

  /** Close all suggestion lists (e.g. after sending). */
  const clear = useCallback(() => {
    setAtQuery(null)
    setEmojiQuery(null)
    setSlashQuery(null)
  }, [])

  return {
    mention: {
      suggestions,
      selectedIndex,
      setSelectedIndex,
      insert: insertMention,
      refs: suggestionRefs,
    },
    emoji: {
      suggestions: emojiSuggestions,
      selectedIndex: selectedEmojiIndex,
      setSelectedIndex: setSelectedEmojiIndex,
      insert: insertEmoji,
    },
    slash: {
      suggestions: slashSuggestions,
      selectedIndex: selectedSlashIndex,
      setSelectedIndex: setSelectedSlashIndex,
      insert: insertSlashCommand,
    },
    onInputChange,
    onKeyDown,
    clear,
  }
}
