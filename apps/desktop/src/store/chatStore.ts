import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  Channel,
  Message,
  Member,
  DMChannelData,
  GroupDMChannelData,
  MessageReaction,
  PinnedMessage,
  Thread,
  PollData,
} from '@kizuna/shared'

interface ChatState {
  channels: Channel[]
  dmChannels: DMChannelData[]
  groupDMChannels: GroupDMChannelData[]
  categories: { id: string; name: string; position: number }[]
  messages: Record<string, Message[]>
  polls: Record<string, PollData[]>
  pinnedMessages: Record<string, PinnedMessage[]>
  threads: Record<string, Thread[]>
  threadMessages: Record<string, Message[]>
  activeThreadId: string | null
  threadPanelVisible: boolean
  members: Member[]
  activeChannelId: string | null
  activeDMChannelId: string | null
  activeGroupDMChannelId: string | null
  /** Voice channel whose "stage" view fills the main area. Independent of the
   *  connected call (voiceStore.activeVoiceChannelId) so you can browse text
   *  channels mid-call. Mutually exclusive with the active text/DM/group views. */
  viewedVoiceChannelId: string | null
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>
  serverMentionCounts: Record<string, number>
  typingUsers: Record<string, string[]>
  /** serverId -> channelId -> muted-until (ms) or null for "until unmuted".
   * Keyed per server because background servers sync their mutes too. */
  channelMutes: Record<string, Record<string, number | null>>
  channelLastReadAt: Record<string, number>
  hasMoreMessages: Record<string, boolean>
  loadingMoreMessages: Record<string, boolean>
  loadMoreErrors: Record<string, string | null>
  pendingMention: string | null
  channelDrafts: Record<string, string>

  setChannels: (channels: Channel[]) => void
  setCategories: (categories: { id: string; name: string; position: number }[]) => void
  setDMChannels: (channels: DMChannelData[]) => void
  setGroupDMChannels: (channels: GroupDMChannelData[]) => void
  setMessages: (channelId: string, messages: Message[]) => void
  reconcileMessages: (channelId: string, messages: Message[]) => void
  addMessage: (channelId: string, message: Message) => void
  updateMessage: (channelId: string, messageId: string, message: Message) => void
  addPoll: (channelId: string, poll: PollData) => void
  setPolls: (channelId: string, polls: PollData[]) => void
  updatePoll: (
    pollId: string,
    options: { id: string; label: string; position: number; vote_count: number }[],
  ) => void
  removePoll: (channelId: string, pollId: string) => void
  setPinnedMessages: (channelId: string, pins: PinnedMessage[]) => void
  addPinnedMessage: (channelId: string, pin: PinnedMessage) => void
  removePinnedMessage: (channelId: string, messageId: string) => void
  setThreads: (channelId: string, threads: Thread[]) => void
  addThread: (channelId: string, thread: Thread) => void
  removeThread: (channelId: string, threadId: string) => void
  setThreadMessages: (threadId: string, messages: Message[]) => void
  addThreadMessage: (threadId: string, message: Message) => void
  /** Thread messages share ids with the messages table, so an edit/delete
   * event (which carries no thread id on delete) is applied by message id. */
  updateThreadMessage: (messageId: string, message: Message) => void
  removeThreadMessage: (messageId: string) => void
  setActiveThreadId: (threadId: string | null) => void
  setThreadPanelVisible: (visible: boolean) => void
  setMembers: (members: Member[]) => void
  setActiveChannel: (channelId: string | null) => void
  setActiveDMChannel: (channelId: string | null) => void
  setActiveGroupDMChannel: (channelId: string | null) => void
  setViewedVoiceChannel: (channelId: string | null) => void
  setUnreadCounts: (counts: Record<string, number>) => void
  setMentionCounts: (counts: Record<string, number>) => void
  incrementServerMentionCount: (serverId: string) => void
  clearServerMentionCount: (serverId: string) => void
  removeMessage: (channelId: string, messageId: string) => void
  setTypingUsers: (channelId: string, users: string[]) => void
  setChannelMutes: (serverId: string, mutes: Record<string, number | null>) => void
  upsertChannelMute: (serverId: string, channelId: string, mutedUntil: number | null) => void
  removeChannelMute: (serverId: string, channelId: string) => void
  setChannelLastReadAt: (channelId: string, timestamp: number) => void
  setHasMoreMessages: (channelId: string, hasMore: boolean) => void
  setLoadingMoreMessages: (channelId: string, loading: boolean) => void
  setLoadMoreError: (channelId: string, error: string | null) => void
  prependMessages: (channelId: string, messages: Message[]) => void
  updateMessageReactions: (
    channelId: string,
    messageId: string,
    reactions: MessageReaction[],
  ) => void
  clearServerData: () => void
  setPendingMention: (username: string | null) => void
  setChannelDraft: (channelId: string, draft: string) => void
}

/** Soft cap on a channel's cached messages. Live appends trim the oldest end
 * back to this, but never below what the user has deliberately paged back
 * through: older history loaded by scrolling up is kept until the channel's
 * cache is replaced, so the page just fetched can't be thrown away again. */
export const MAX_MESSAGES = 500

/** Trim `list` from the oldest end. `floor` is the length the cache already
 * had, so a paginated history is never shrunk below what was on screen. */
function trimOldest(list: Message[], floor: number): { list: Message[]; trimmed: boolean } {
  const cap = Math.max(MAX_MESSAGES, floor)
  if (list.length <= cap) return { list, trimmed: false }
  return { list: list.slice(-cap), trimmed: true }
}

/** Per-conversation view state that must reset whenever the active
 * conversation actually changes (a thread belongs to one channel). */
function conversationSwitchReset(s: ChatState, next: string | null): Partial<ChatState> {
  const current =
    s.activeChannelId || s.activeDMChannelId || s.activeGroupDMChannelId || s.viewedVoiceChannelId
  if (current === next) return {}
  return { activeThreadId: null, threadPanelVisible: false }
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      channels: [],
      categories: [],
      dmChannels: [],
      groupDMChannels: [],
      messages: {},
      polls: {},
      pinnedMessages: {},
      threads: {},
      threadMessages: {},
      activeThreadId: null,
      threadPanelVisible: false,
      members: [],
      activeChannelId: null,
      activeDMChannelId: null,
      activeGroupDMChannelId: null,
      viewedVoiceChannelId: null,
      unreadCounts: {},
      mentionCounts: {},
      serverMentionCounts: {},
      typingUsers: {},
      channelMutes: {},
      channelLastReadAt: {},
      hasMoreMessages: {},
      loadingMoreMessages: {},
      loadMoreErrors: {},
      pendingMention: null,
      channelDrafts: {},

      setChannels: (channels) => set({ channels }),
      setCategories: (categories) => set({ categories }),
      setDMChannels: (dmChannels) => set({ dmChannels }),
      setGroupDMChannels: (groupDMChannels) => set({ groupDMChannels }),
      setMessages: (channelId, messages) =>
        set((state) => ({ messages: { ...state.messages, [channelId]: messages } })),
      /* Merge a freshly fetched newest-page into whatever is already cached,
       * instead of replacing it. Re-entering a channel used to discard every
       * older page the user had scrolled back through.
       *
       * Only merges when the incoming page overlaps the cache by at least one
       * id. No overlap means more than a page of messages arrived while we
       * were away, so the cache and the new page are separated by a gap —
       * splicing them would render a contiguous history that never happened.
       * In that case the stale cache is dropped.
       *
       * Trade-off: a message deleted server-side while we were away survives
       * in the cached half. The socket delete event corrects it. */
      reconcileMessages: (channelId, messages) =>
        set((state) => {
          const existing = state.messages[channelId] || []
          if (existing.length === 0) {
            return { messages: { ...state.messages, [channelId]: messages } }
          }
          const existingIds = new Set(existing.map((m) => m.id))
          const overlaps = messages.some((m) => existingIds.has(m.id))
          if (!overlaps) {
            return { messages: { ...state.messages, [channelId]: messages } }
          }
          // Incoming wins on conflict — it carries fresher edits and reactions.
          const byId = new Map(existing.map((m) => [m.id, m]))
          for (const m of messages) byId.set(m.id, m)
          const merged = [...byId.values()].sort((a, b) => a.created_at - b.created_at)
          const { list, trimmed } = trimOldest(merged, existing.length)
          return {
            messages: { ...state.messages, [channelId]: list },
            ...(trimmed
              ? { hasMoreMessages: { ...state.hasMoreMessages, [channelId]: true } }
              : {}),
          }
        }),
      addMessage: (channelId, message) =>
        set((state) => {
          const existing = state.messages[channelId] || []
          if (existing.some((m) => m.id === message.id)) return state
          const { list, trimmed } = trimOldest([...existing, message], existing.length)
          return {
            messages: {
              ...state.messages,
              [channelId]: list,
            },
            ...(trimmed
              ? { hasMoreMessages: { ...state.hasMoreMessages, [channelId]: true } }
              : {}),
          }
        }),
      addPoll: (channelId, poll) =>
        set((state) => {
          const existing = state.polls[channelId] || []
          if (existing.some((p) => p.pollId === poll.pollId)) return state
          const MAX_POLLS = 100
          const appended = [...existing, poll]
          const trimmed = appended.length > MAX_POLLS ? appended.slice(-MAX_POLLS) : appended
          return {
            polls: { ...state.polls, [channelId]: trimmed },
          }
        }),
      setPolls: (channelId, polls) =>
        set((state) => ({
          polls: { ...state.polls, [channelId]: polls },
        })),
      updatePoll: (pollId, options) =>
        set((state) => {
          const updated: typeof state.polls = {}
          for (const [channelId, channelPolls] of Object.entries(state.polls)) {
            updated[channelId] = channelPolls.map((p) =>
              p.pollId === pollId
                ? {
                    ...p,
                    options: p.options.map((o) => {
                      const updatedOption = options.find((uo) => uo.id === o.id)
                      return updatedOption ? { ...o, vote_count: updatedOption.vote_count } : o
                    }),
                  }
                : p,
            )
          }
          return { polls: { ...state.polls, ...updated } }
        }),
      removePoll: (channelId, pollId) =>
        set((state) => ({
          polls: {
            ...state.polls,
            [channelId]: (state.polls[channelId] || []).filter((p) => p.pollId !== pollId),
          },
        })),
      updateMessage: (channelId, messageId, message) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: (state.messages[channelId] || []).map((m) =>
              m.id === messageId ? message : m,
            ),
          },
        })),
      setPinnedMessages: (channelId, pinnedMessages) =>
        set((state) => ({
          pinnedMessages: { ...state.pinnedMessages, [channelId]: pinnedMessages },
        })),
      addPinnedMessage: (channelId, pin) =>
        set((state) => {
          const existing = state.pinnedMessages[channelId] || []
          if (existing.some((p) => p.id === pin.id)) return state
          return {
            pinnedMessages: {
              ...state.pinnedMessages,
              [channelId]: [pin, ...existing],
            },
          }
        }),
      removePinnedMessage: (channelId, messageId) =>
        set((state) => ({
          pinnedMessages: {
            ...state.pinnedMessages,
            [channelId]: (state.pinnedMessages[channelId] || []).filter(
              (p) => p.messageId !== messageId,
            ),
          },
        })),
      setThreads: (channelId, threads) =>
        set((state) => ({
          threads: { ...state.threads, [channelId]: threads },
        })),
      addThread: (channelId, thread) =>
        set((state) => {
          const existing = state.threads[channelId] || []
          if (existing.some((t) => t.id === thread.id)) return state
          return {
            threads: {
              ...state.threads,
              [channelId]: [thread, ...existing],
            },
          }
        }),
      removeThread: (channelId, threadId) =>
        set((state) => {
          const existing = state.threads[channelId] || []
          const filtered = existing.filter((t) => t.id !== threadId)
          if (filtered.length === existing.length) return state
          const nextThreads = { ...state.threads }
          if (filtered.length === 0) {
            delete nextThreads[channelId]
          } else {
            nextThreads[channelId] = filtered
          }
          const nextThreadMessages = { ...state.threadMessages }
          delete nextThreadMessages[threadId]
          return {
            threads: nextThreads,
            threadMessages: nextThreadMessages,
            activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
          }
        }),
      setThreadMessages: (threadId, messages) =>
        set((state) => ({
          threadMessages: { ...state.threadMessages, [threadId]: messages },
        })),
      addThreadMessage: (threadId, message) =>
        set((state) => {
          const existing = state.threadMessages[threadId] || []
          if (existing.some((m) => m.id === message.id)) return state
          return {
            threadMessages: {
              ...state.threadMessages,
              [threadId]: [...existing, message],
            },
          }
        }),
      updateThreadMessage: (messageId, message) =>
        set((state) => {
          let changed = false
          const next: Record<string, Message[]> = {}
          for (const [threadId, msgs] of Object.entries(state.threadMessages)) {
            if (msgs.some((m) => m.id === messageId)) {
              changed = true
              next[threadId] = msgs.map((m) => (m.id === messageId ? { ...m, ...message } : m))
            } else {
              next[threadId] = msgs
            }
          }
          return changed ? { threadMessages: next } : state
        }),
      removeThreadMessage: (messageId) =>
        set((state) => {
          let changed = false
          const next: Record<string, Message[]> = {}
          for (const [threadId, msgs] of Object.entries(state.threadMessages)) {
            const filtered = msgs.filter((m) => m.id !== messageId)
            if (filtered.length !== msgs.length) changed = true
            next[threadId] = filtered
          }
          return changed ? { threadMessages: next } : state
        }),
      setActiveThreadId: (activeThreadId) =>
        // Going back to the thread list (null) keeps the panel open.
        set(
          activeThreadId !== null
            ? { activeThreadId, threadPanelVisible: true }
            : { activeThreadId },
        ),
      setThreadPanelVisible: (threadPanelVisible) => set({ threadPanelVisible }),
      setMembers: (members) => set({ members }),
      setActiveChannel: (activeChannelId) =>
        set((s) => ({
          ...conversationSwitchReset(s, activeChannelId),
          activeChannelId,
          activeDMChannelId: null,
          activeGroupDMChannelId: null,
          viewedVoiceChannelId: null,
        })),
      setActiveDMChannel: (activeDMChannelId) =>
        set((s) => ({
          ...conversationSwitchReset(s, activeDMChannelId),
          activeDMChannelId,
          activeChannelId: null,
          activeGroupDMChannelId: null,
          viewedVoiceChannelId: null,
        })),
      setActiveGroupDMChannel: (activeGroupDMChannelId) =>
        set((s) => ({
          ...conversationSwitchReset(s, activeGroupDMChannelId),
          activeGroupDMChannelId,
          activeChannelId: null,
          activeDMChannelId: null,
          viewedVoiceChannelId: null,
        })),
      setViewedVoiceChannel: (viewedVoiceChannelId) =>
        set((s) => ({
          ...conversationSwitchReset(s, viewedVoiceChannelId),
          viewedVoiceChannelId,
          activeChannelId: null,
          activeDMChannelId: null,
          activeGroupDMChannelId: null,
        })),
      setUnreadCounts: (unreadCounts) => set({ unreadCounts }),
      setMentionCounts: (mentionCounts) => set({ mentionCounts }),
      incrementServerMentionCount: (serverId) =>
        set((s) => ({
          serverMentionCounts: {
            ...s.serverMentionCounts,
            [serverId]: (s.serverMentionCounts[serverId] || 0) + 1,
          },
        })),
      clearServerMentionCount: (serverId) =>
        set((s) => {
          const next = { ...s.serverMentionCounts }
          delete next[serverId]
          return { serverMentionCounts: next }
        }),
      removeMessage: (channelId, messageId) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: state.messages[channelId]?.filter((m) => m.id !== messageId) || [],
          },
        })),
      setTypingUsers: (channelId, users) =>
        set((s) => ({
          typingUsers: { ...s.typingUsers, [channelId]: users },
        })),
      setChannelMutes: (serverId, mutes) =>
        set((s) => ({ channelMutes: { ...s.channelMutes, [serverId]: mutes } })),
      upsertChannelMute: (serverId, channelId, mutedUntil) =>
        set((s) => ({
          channelMutes: {
            ...s.channelMutes,
            [serverId]: { ...s.channelMutes[serverId], [channelId]: mutedUntil },
          },
        })),
      removeChannelMute: (serverId, channelId) =>
        set((s) => {
          const next = { ...s.channelMutes[serverId] }
          delete next[channelId]
          return { channelMutes: { ...s.channelMutes, [serverId]: next } }
        }),
      setChannelLastReadAt: (channelId, timestamp) =>
        set((s) => ({
          channelLastReadAt: { ...s.channelLastReadAt, [channelId]: timestamp },
        })),
      setHasMoreMessages: (channelId, hasMore) =>
        set((s) => ({
          hasMoreMessages: { ...s.hasMoreMessages, [channelId]: hasMore },
        })),
      setLoadingMoreMessages: (channelId, loading) =>
        set((s) => ({
          loadingMoreMessages: { ...s.loadingMoreMessages, [channelId]: loading },
        })),
      setLoadMoreError: (channelId, error) =>
        set((s) => ({
          loadMoreErrors: { ...s.loadMoreErrors, [channelId]: error },
        })),
      prependMessages: (channelId, messages) =>
        set((s) => {
          const existing = s.messages[channelId] || []
          const existingIds = new Set(existing.map((m) => m.id))
          const deduped = messages.filter((m) => !existingIds.has(m.id))
          if (deduped.length === 0) return s
          // Never trim on prepend: the reader is looking at the oldest end,
          // which is exactly the page just fetched. Trimming the newest end
          // instead would need "load newer" pagination, which nothing has.
          // Growth is bounded by how far back the user actually scrolls, and
          // the cache is replaced when the channel is re-entered after a gap.
          const merged = [...deduped, ...existing]
          return { messages: { ...s.messages, [channelId]: merged } }
        }),
      updateMessageReactions: (channelId, messageId, reactions) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: (state.messages[channelId] || []).map((m) =>
              m.id === messageId ? { ...m, reactions } : m,
            ),
          },
        })),
      clearServerData: () =>
        set({
          channels: [],
          categories: [],
          dmChannels: [],
          groupDMChannels: [],
          messages: {},
          polls: {},
          pinnedMessages: {},
          threads: {},
          threadMessages: {},
          members: [],
          activeChannelId: null,
          activeDMChannelId: null,
          activeGroupDMChannelId: null,
          viewedVoiceChannelId: null,
          typingUsers: {},
          // channelMutes is keyed per server and also fed by background
          // servers, so it survives a server switch.
          hasMoreMessages: {},
          loadingMoreMessages: {},
          loadMoreErrors: {},
          activeThreadId: null,
          threadPanelVisible: false,
          pendingMention: null,
        }),
      setPendingMention: (pendingMention) => set({ pendingMention }),
      setChannelDraft: (channelId, draft) =>
        set((state) => ({
          channelDrafts: { ...state.channelDrafts, [channelId]: draft },
        })),
    }),
    {
      name: 'kizuna-chat-v1',
      partialize: (state) => ({
        unreadCounts: state.unreadCounts,
        mentionCounts: state.mentionCounts,
        serverMentionCounts: state.serverMentionCounts,
        channelDrafts: state.channelDrafts,
      }),
    },
  ),
)
