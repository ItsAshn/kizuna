import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Channel, Message, Member, DMChannelData, GroupDMChannelData, MessageReaction, PinnedMessage, Thread, PollData } from '@kizuna/shared';

interface ChatState {
  channels: Channel[];
  dmChannels: DMChannelData[];
  groupDMChannels: GroupDMChannelData[];
  categories: { id: string; name: string; position: number }[];
  messages: Record<string, Message[]>;
  polls: Record<string, PollData[]>;
  pinnedMessages: Record<string, PinnedMessage[]>;
  threads: Record<string, Thread[]>;
  threadMessages: Record<string, Message[]>;
  activeThreadId: string | null;
  threadPanelVisible: boolean;
  members: Member[];
  activeChannelId: string | null;
  activeDMChannelId: string | null;
  activeGroupDMChannelId: string | null;
  /** Voice channel whose "stage" view fills the main area. Independent of the
   *  connected call (voiceStore.activeVoiceChannelId) so you can browse text
   *  channels mid-call. Mutually exclusive with the active text/DM/group views. */
  viewedVoiceChannelId: string | null;
  unreadCounts: Record<string, number>;
  mentionCounts: Record<string, number>;
  serverMentionCounts: Record<string, number>;
  typingUsers: Record<string, string[]>;
  channelMutes: Record<string, number | null>;
  channelLastReadAt: Record<string, number>;
  hasMoreMessages: Record<string, boolean>;
  loadingMoreMessages: Record<string, boolean>;
  loadMoreErrors: Record<string, string | null>;
  pendingMention: string | null;
  channelDrafts: Record<string, string>;

  setChannels: (channels: Channel[]) => void;
  setCategories: (categories: { id: string; name: string; position: number }[]) => void;
  setDMChannels: (channels: DMChannelData[]) => void;
  setGroupDMChannels: (channels: GroupDMChannelData[]) => void;
  setMessages: (channelId: string, messages: Message[]) => void;
  addMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, messageId: string, message: Message) => void;
  addPoll: (channelId: string, poll: PollData) => void;
  setPolls: (channelId: string, polls: PollData[]) => void;
  updatePoll: (pollId: string, options: { id: string; label: string; position: number; vote_count: number }[]) => void;
  removePoll: (channelId: string, pollId: string) => void;
  setPinnedMessages: (channelId: string, pins: PinnedMessage[]) => void;
  addPinnedMessage: (channelId: string, pin: PinnedMessage) => void;
  removePinnedMessage: (channelId: string, messageId: string) => void;
  setThreads: (channelId: string, threads: Thread[]) => void;
  addThread: (channelId: string, thread: Thread) => void;
  removeThread: (channelId: string, threadId: string) => void;
  setThreadMessages: (threadId: string, messages: Message[]) => void;
  addThreadMessage: (threadId: string, message: Message) => void;
  setActiveThreadId: (threadId: string | null) => void;
  setThreadPanelVisible: (visible: boolean) => void;
  setMembers: (members: Member[]) => void;
  setActiveChannel: (channelId: string | null) => void;
  setActiveDMChannel: (channelId: string | null) => void;
  setActiveGroupDMChannel: (channelId: string | null) => void;
  setViewedVoiceChannel: (channelId: string | null) => void;
  setUnreadCounts: (counts: Record<string, number>) => void;
  setMentionCounts: (counts: Record<string, number>) => void;
  incrementServerMentionCount: (serverId: string) => void;
  clearServerMentionCount: (serverId: string) => void;
  removeMessage: (channelId: string, messageId: string) => void;
  setTypingUsers: (channelId: string, users: string[]) => void;
  setChannelMutes: (mutes: Record<string, number | null>) => void;
  upsertChannelMute: (channelId: string, mutedUntil: number | null) => void;
  removeChannelMute: (channelId: string) => void;
  setChannelLastReadAt: (channelId: string, timestamp: number) => void;
  setHasMoreMessages: (channelId: string, hasMore: boolean) => void;
  setLoadingMoreMessages: (channelId: string, loading: boolean) => void;
  setLoadMoreError: (channelId: string, error: string | null) => void;
  prependMessages: (channelId: string, messages: Message[]) => void;
  updateMessageReactions: (channelId: string, messageId: string, reactions: MessageReaction[]) => void;
  clearServerData: () => void;
  setPendingMention: (username: string | null) => void;
  setChannelDraft: (channelId: string, draft: string) => void;
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
      addMessage: (channelId, message) =>
        set((state) => {
          const existing = state.messages[channelId] || [];
          if (existing.some((m) => m.id === message.id)) return state;
          const MAX_MESSAGES = 500
          const appended = [...existing, message]
          const trimmed = appended.length > MAX_MESSAGES ? appended.slice(-MAX_MESSAGES) : appended
          return {
            messages: {
              ...state.messages,
              [channelId]: trimmed,
            },
          };
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
              p.pollId === pollId ? { ...p, options: p.options.map((o) => {
                const updatedOption = options.find((uo) => uo.id === o.id)
                return updatedOption ? { ...o, vote_count: updatedOption.vote_count } : o
              }) } : p
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
      setActiveThreadId: (activeThreadId) => set({ activeThreadId, threadPanelVisible: activeThreadId !== null ? true : undefined }),
      setThreadPanelVisible: (threadPanelVisible) => set({ threadPanelVisible }),
      setMembers: (members) => set({ members }),
      setActiveChannel: (activeChannelId) => set({ activeChannelId, activeDMChannelId: null, activeGroupDMChannelId: null, viewedVoiceChannelId: null }),
      setActiveDMChannel: (activeDMChannelId) => set({ activeDMChannelId, activeChannelId: null, activeGroupDMChannelId: null, viewedVoiceChannelId: null }),
      setActiveGroupDMChannel: (activeGroupDMChannelId) => set({ activeGroupDMChannelId, activeChannelId: null, activeDMChannelId: null, viewedVoiceChannelId: null }),
      setViewedVoiceChannel: (viewedVoiceChannelId) => set({ viewedVoiceChannelId, activeChannelId: null, activeDMChannelId: null, activeGroupDMChannelId: null }),
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
          const next = { ...s.serverMentionCounts };
          delete next[serverId];
          return { serverMentionCounts: next };
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
      setChannelMutes: (channelMutes) => set({ channelMutes }),
      upsertChannelMute: (channelId, mutedUntil) =>
        set((s) => ({ channelMutes: { ...s.channelMutes, [channelId]: mutedUntil } })),
      removeChannelMute: (channelId) =>
        set((s) => {
          const next = { ...s.channelMutes };
          delete next[channelId];
          return { channelMutes: next };
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
          const MAX_MESSAGES = 500
          const merged = [...deduped, ...existing]
          const trimmed = merged.length > MAX_MESSAGES ? merged.slice(-MAX_MESSAGES) : merged
          return {
            messages: { ...s.messages, [channelId]: trimmed },
            hasMoreMessages: { ...s.hasMoreMessages, [channelId]: merged.length > MAX_MESSAGES ? true : s.hasMoreMessages[channelId] },
          }
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
          channelMutes: {},
          hasMoreMessages: {},
          loadingMoreMessages: {},
          loadMoreErrors: {},
          activeThreadId: null,
          threadPanelVisible: false,
          pendingMention: null,
        }),
      setPendingMention: (pendingMention) => set({ pendingMention }),
      setChannelDraft: (channelId, draft) => set((state) => ({
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
);
