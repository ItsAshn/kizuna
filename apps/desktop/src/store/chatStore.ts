import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Channel, Message, Member, DMChannelData, MessageReaction } from '@kizuna/shared';

interface ChatState {
  channels: Channel[];
  dmChannels: DMChannelData[];
  messages: Record<string, Message[]>;
  members: Member[];
  activeChannelId: string | null;
  activeDMChannelId: string | null;
  unreadCounts: Record<string, number>;
  mentionCounts: Record<string, number>;
  serverMentionCounts: Record<string, number>;
  typingUsers: Record<string, string[]>;
  channelMutes: Record<string, number | null>;
  channelLastReadAt: Record<string, number>;
  hasMoreMessages: Record<string, boolean>;

  setChannels: (channels: Channel[]) => void;
  setDMChannels: (channels: DMChannelData[]) => void;
  setMessages: (channelId: string, messages: Message[]) => void;
  addMessage: (channelId: string, message: Message) => void;
  updateMessage: (channelId: string, messageId: string, message: Message) => void;
  setMembers: (members: Member[]) => void;
  setActiveChannel: (channelId: string | null) => void;
  setActiveDMChannel: (channelId: string | null) => void;
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
  prependMessages: (channelId: string, messages: Message[]) => void;
  updateMessageReactions: (channelId: string, messageId: string, reactions: MessageReaction[]) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      channels: [],
      dmChannels: [],
      messages: {},
      members: [],
      activeChannelId: null,
      activeDMChannelId: null,
      unreadCounts: {},
      mentionCounts: {},
      serverMentionCounts: {},
      typingUsers: {},
      channelMutes: {},
      channelLastReadAt: {},
      hasMoreMessages: {},

      setChannels: (channels) => set({ channels }),
      setDMChannels: (dmChannels) => set({ dmChannels }),
      setMessages: (channelId, messages) =>
        set((state) => ({ messages: { ...state.messages, [channelId]: messages } })),
      addMessage: (channelId, message) =>
        set((state) => {
          const existing = state.messages[channelId] || [];
          if (existing.some((m) => m.id === message.id)) return state;
          return {
            messages: {
              ...state.messages,
              [channelId]: [...existing, message],
            },
          };
        }),
      updateMessage: (channelId, messageId, message) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: (state.messages[channelId] || []).map((m) =>
              m.id === messageId ? message : m,
            ),
          },
        })),
      setMembers: (members) => set({ members }),
      setActiveChannel: (activeChannelId) => set({ activeChannelId, activeDMChannelId: null }),
      setActiveDMChannel: (activeDMChannelId) => set({ activeDMChannelId, activeChannelId: null }),
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
      prependMessages: (channelId, messages) =>
        set((s) => ({
          messages: {
            ...s.messages,
            [channelId]: [...messages, ...(s.messages[channelId] || [])],
          },
        })),
      updateMessageReactions: (channelId, messageId, reactions) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: (state.messages[channelId] || []).map((m) =>
              m.id === messageId ? { ...m, reactions } : m,
            ),
          },
        })),
    }),
    {
      name: 'kizuna-chat-v1',
      partialize: (state) => ({
        unreadCounts: state.unreadCounts,
        mentionCounts: state.mentionCounts,
        serverMentionCounts: state.serverMentionCounts,
      }),
    },
  ),
);
