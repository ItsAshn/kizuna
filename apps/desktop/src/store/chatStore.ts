import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Channel, Message, Member, DMChannelData, VoicePeer, ConnectionQuality } from '@kizuna/shared'

interface ChatState {
  channels: Channel[]
  dmChannels: DMChannelData[]
  messages: Record<string, Message[]>
  members: Member[]
  activeChannelId: string | null
  activeDMChannelId: string | null
  unreadCounts: Record<string, number>
  mentionCounts: Record<string, number>

  activeVoiceChannelId: string | null
  voicePeers: VoicePeer[]
  isMuted: boolean
  isSpeaking: boolean
  localConnectionQuality: ConnectionQuality | null
  audioBitrateKbps: number
  audioInputDeviceId: string | null
  audioOutputDeviceId: string | null
  voiceError: string | null
  typingUsers: Record<string, string[]>

  setChannels: (channels: Channel[]) => void
  setDMChannels: (channels: DMChannelData[]) => void
  setMessages: (channelId: string, messages: Message[]) => void
  addMessage: (channelId: string, message: Message) => void
  setMembers: (members: Member[]) => void
  setActiveChannel: (channelId: string | null) => void
  setActiveDMChannel: (channelId: string | null) => void
  setUnreadCounts: (counts: Record<string, number>) => void
  setMentionCounts: (counts: Record<string, number>) => void
  removeMessage: (channelId: string, messageId: string) => void
  setActiveVoiceChannel: (channelId: string | null) => void
  setVoicePeers: (peers: VoicePeer[]) => void
  addVoicePeer: (peer: VoicePeer) => void
  removeVoicePeer: (peerId: string) => void
  updateVoicePeer: (peerId: string, patch: Partial<VoicePeer>) => void
  setIsMuted: (muted: boolean) => void
  setIsSpeaking: (speaking: boolean) => void
  setLocalConnectionQuality: (quality: ConnectionQuality | null) => void
  setAudioBitrateKbps: (kbps: number) => void
  setAudioInputDeviceId: (id: string | null) => void
  setAudioOutputDeviceId: (id: string | null) => void
  setVoiceError: (error: string | null) => void
  setTypingUsers: (channelId: string, users: string[]) => void
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
      activeVoiceChannelId: null,
      voicePeers: [],
      isMuted: false,
      isSpeaking: false,
      localConnectionQuality: null,
      audioBitrateKbps: 64,
      audioInputDeviceId: null,
      audioOutputDeviceId: null,
      voiceError: null,
      typingUsers: {},

      setChannels: (channels) => set({ channels }),
      setDMChannels: (dmChannels) => set({ dmChannels }),
      setMessages: (channelId, messages) =>
        set((state) => ({ messages: { ...state.messages, [channelId]: messages } })),
      addMessage: (channelId, message) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: [...(state.messages[channelId] || []), message],
          },
        })),
      setMembers: (members) => set({ members }),
      setActiveChannel: (activeChannelId) => set({ activeChannelId, activeDMChannelId: null }),
      setActiveDMChannel: (activeDMChannelId) => set({ activeDMChannelId, activeChannelId: null }),
      setUnreadCounts: (unreadCounts) => set({ unreadCounts }),
      setMentionCounts: (mentionCounts) => set({ mentionCounts }),
      removeMessage: (channelId, messageId) =>
        set((state) => ({
          messages: {
            ...state.messages,
            [channelId]: state.messages[channelId]?.filter((m) => m.id !== messageId) || [],
          },
        })),

      setActiveVoiceChannel: (activeVoiceChannelId) => set({ activeVoiceChannelId }),
      setVoicePeers: (voicePeers) => set({ voicePeers }),
      addVoicePeer: (peer) => set((s) => ({ voicePeers: [...s.voicePeers.filter(p => p.id !== peer.id), peer] })),
      removeVoicePeer: (peerId) => set((s) => ({ voicePeers: s.voicePeers.filter(p => p.id !== peerId) })),
      updateVoicePeer: (peerId, patch) =>
        set((s) => ({
          voicePeers: s.voicePeers.map((p) =>
            p.id === peerId ? { ...p, ...patch } : p,
          ),
        })),
      setIsMuted: (isMuted) => set({ isMuted }),
      setIsSpeaking: (isSpeaking) => set({ isSpeaking }),
      setLocalConnectionQuality: (localConnectionQuality) => set({ localConnectionQuality }),
      setAudioBitrateKbps: (audioBitrateKbps) => set({ audioBitrateKbps }),
      setAudioInputDeviceId: (audioInputDeviceId) => set({ audioInputDeviceId }),
      setAudioOutputDeviceId: (audioOutputDeviceId) => set({ audioOutputDeviceId }),
      setVoiceError: (voiceError) => set({ voiceError }),
      setTypingUsers: (channelId, users) =>
        set((s) => ({
          typingUsers: { ...s.typingUsers, [channelId]: users },
        })),
    }),
    {
      name: 'kizuna-voice-settings',
      partialize: (state) => ({
        audioInputDeviceId: state.audioInputDeviceId,
        audioOutputDeviceId: state.audioOutputDeviceId,
        audioBitrateKbps: state.audioBitrateKbps,
      }),
    },
  ),
)
