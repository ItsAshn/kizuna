import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Channel, Message, Member, DMChannelData, VoicePeer, ConnectionQuality, ScreenSharePeer, MonitorInfo, UserStatus, MessageReaction } from '@kizuna/shared'

export type VoiceInputMode = 'voice-activity' | 'push-to-talk'

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
  serverVoiceBitrateKbps: number
  audioInputDeviceId: string | null
  audioOutputDeviceId: string | null
  voiceError: string | null
  typingUsers: Record<string, string[]>

  userStatuses: Record<string, UserStatus>

  voiceInputMode: VoiceInputMode
  pushToTalkKey: string
  noiseSuppression: boolean
  autoGainControl: boolean
  noiseGateEnabled: boolean
  noiseGateThreshold: number
  noiseSuppressionStrength: number
  inputVolume: number
  outputVolume: number
  liveAudioLevel: number

  voiceChannelUsers: Record<string, { userId: string; username: string }[]>

  screenSharePeerId: string | null
  screenShareUsername: string | null
  isScreenSharing: boolean
  screenShareVideoProducerId: string | null
  availableMonitors: MonitorInfo[]

  serverBackgroundEnabled: boolean
  customCssEnabled: boolean

  updateState: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  updateProgress: number
  updateVersion: string | null
  updateError: string | null

  channelMutes: Record<string, number | null>

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
  setServerVoiceBitrateKbps: (kbps: number) => void
  setAudioInputDeviceId: (id: string | null) => void
  setAudioOutputDeviceId: (id: string | null) => void
  setVoiceError: (error: string | null) => void
  setVoiceChannelUsers: (users: Record<string, { userId: string; username: string }[]>) => void
  addVoiceChannelUser: (channelId: string, user: { userId: string; username: string }) => void
  removeVoiceChannelUser: (channelId: string, userId: string) => void
  setVoiceInputMode: (mode: VoiceInputMode) => void
  setPushToTalkKey: (key: string) => void
  setNoiseSuppression: (enabled: boolean) => void
  setAutoGainControl: (enabled: boolean) => void
  setNoiseGateEnabled: (enabled: boolean) => void
  setNoiseGateThreshold: (threshold: number) => void
  setNoiseSuppressionStrength: (strength: number) => void
  setInputVolume: (volume: number) => void
  setOutputVolume: (volume: number) => void
  setLiveAudioLevel: (level: number) => void
  setTypingUsers: (channelId: string, users: string[]) => void
  setUserStatus: (userId: string, status: UserStatus) => void
  setUserStatuses: (statuses: Record<string, UserStatus>) => void
  setScreenSharePeer: (peerId: string | null, username: string | null) => void
  clearScreenSharePeer: () => void
  setIsScreenSharing: (active: boolean) => void
  setScreenShareVideoProducerId: (producerId: string | null) => void
  setAvailableMonitors: (monitors: MonitorInfo[]) => void
  setServerBackgroundEnabled: (enabled: boolean) => void
  setCustomCssEnabled: (enabled: boolean) => void
  setUpdateState: (state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error') => void
  setUpdateProgress: (progress: number) => void
  setUpdateVersion: (version: string | null) => void
  setUpdateError: (error: string | null) => void

  setChannelMutes: (mutes: Record<string, number | null>) => void
  upsertChannelMute: (channelId: string, mutedUntil: number | null) => void
  removeChannelMute: (channelId: string) => void

  updateMessageReactions: (channelId: string, messageId: string, reactions: MessageReaction[]) => void
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
      serverVoiceBitrateKbps: 64,
      audioInputDeviceId: null,
      audioOutputDeviceId: null,
      voiceError: null,
      voiceChannelUsers: {},
      typingUsers: {},
      userStatuses: {},
      voiceInputMode: 'voice-activity' as VoiceInputMode,
      pushToTalkKey: 'AltLeft',
      noiseSuppression: false,
      autoGainControl: true,
      noiseGateEnabled: true,
      noiseGateThreshold: 30,
      noiseSuppressionStrength: 0,
      inputVolume: 100,
      outputVolume: 100,
      liveAudioLevel: 0,
      screenSharePeerId: null,
      screenShareUsername: null,
      isScreenSharing: false,
      screenShareVideoProducerId: null,
      availableMonitors: [],
      serverBackgroundEnabled: true,
      customCssEnabled: true,
      updateState: 'idle' as const,
      updateProgress: 0,
      updateVersion: null,
      updateError: null,
      channelMutes: {},

      setChannels: (channels) => set({ channels }),
      setDMChannels: (dmChannels) => set({ dmChannels }),
      setMessages: (channelId, messages) =>
        set((state) => ({ messages: { ...state.messages, [channelId]: messages } })),
      addMessage: (channelId, message) =>
        set((state) => {
          const existing = state.messages[channelId] || []
          if (existing.some((m) => m.id === message.id)) return state
          return {
            messages: {
              ...state.messages,
              [channelId]: [...existing, message],
            },
          }
        }),
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
      setServerVoiceBitrateKbps: (serverVoiceBitrateKbps) => set({ serverVoiceBitrateKbps }),
      setAudioInputDeviceId: (audioInputDeviceId) => set({ audioInputDeviceId }),
      setAudioOutputDeviceId: (audioOutputDeviceId) => set({ audioOutputDeviceId }),
      setVoiceError: (voiceError) => set({ voiceError }),
      setVoiceChannelUsers: (voiceChannelUsers) => set({ voiceChannelUsers }),
      addVoiceChannelUser: (channelId, user) =>
        set((s) => {
          const current = s.voiceChannelUsers[channelId] || []
          if (current.some((u) => u.userId === user.userId)) return s
          return {
            voiceChannelUsers: {
              ...s.voiceChannelUsers,
              [channelId]: [...current, user],
            },
          }
        }),
      removeVoiceChannelUser: (channelId, userId) =>
        set((s) => {
          const current = s.voiceChannelUsers[channelId] || []
          const filtered = current.filter((u) => u.userId !== userId)
          if (filtered.length === 0) {
            const next = { ...s.voiceChannelUsers }
            delete next[channelId]
            return { voiceChannelUsers: next }
          }
          return {
            voiceChannelUsers: {
              ...s.voiceChannelUsers,
              [channelId]: filtered,
            },
          }
        }),
      setVoiceInputMode: (voiceInputMode) => set({ voiceInputMode }),
      setPushToTalkKey: (pushToTalkKey) => set({ pushToTalkKey }),
      setNoiseSuppression: (noiseSuppression) => set({ noiseSuppression }),
      setAutoGainControl: (autoGainControl) => set({ autoGainControl }),
      setNoiseGateEnabled: (noiseGateEnabled) => set({ noiseGateEnabled }),
      setNoiseGateThreshold: (noiseGateThreshold) => set({ noiseGateThreshold }),
      setNoiseSuppressionStrength: (noiseSuppressionStrength) => set({ noiseSuppressionStrength }),
      setInputVolume: (inputVolume) => set({ inputVolume }),
      setOutputVolume: (outputVolume) => set({ outputVolume }),
      setLiveAudioLevel: (liveAudioLevel) => set({ liveAudioLevel }),
      setTypingUsers: (channelId, users) =>
        set((s) => ({
          typingUsers: { ...s.typingUsers, [channelId]: users },
        })),
      setUserStatus: (userId, status) =>
        set((s) => ({
          userStatuses: { ...s.userStatuses, [userId]: status },
        })),
      setUserStatuses: (statuses) =>
        set((s) => ({
          userStatuses: { ...s.userStatuses, ...statuses },
        })),
      setScreenSharePeer: (screenSharePeerId, screenShareUsername) =>
        set({ screenSharePeerId, screenShareUsername }),
      clearScreenSharePeer: () =>
        set({ screenSharePeerId: null, screenShareUsername: null }),
      setIsScreenSharing: (isScreenSharing) => set({ isScreenSharing }),
      setScreenShareVideoProducerId: (screenShareVideoProducerId) => set({ screenShareVideoProducerId }),
      setAvailableMonitors: (availableMonitors) => set({ availableMonitors }),
      setServerBackgroundEnabled: (serverBackgroundEnabled) => set({ serverBackgroundEnabled }),
      setCustomCssEnabled: (customCssEnabled) => set({ customCssEnabled }),
      setUpdateState: (updateState) => set({ updateState }),
      setUpdateProgress: (updateProgress) => set({ updateProgress }),
      setUpdateVersion: (updateVersion) => set({ updateVersion }),
      setUpdateError: (updateError) => set({ updateError }),

      setChannelMutes: (channelMutes) => set({ channelMutes }),
      upsertChannelMute: (channelId, mutedUntil) =>
        set((s) => ({ channelMutes: { ...s.channelMutes, [channelId]: mutedUntil } })),
      removeChannelMute: (channelId) =>
        set((s) => {
          const next = { ...s.channelMutes }
          delete next[channelId]
          return { channelMutes: next }
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
    }),
    {
      name: 'kizuna-voice-settings',
      partialize: (state) => ({
        audioInputDeviceId: state.audioInputDeviceId,
        audioOutputDeviceId: state.audioOutputDeviceId,
        serverVoiceBitrateKbps: state.serverVoiceBitrateKbps,
        voiceInputMode: state.voiceInputMode,
        pushToTalkKey: state.pushToTalkKey,
        noiseSuppression: state.noiseSuppression,
        autoGainControl: state.autoGainControl,
        noiseGateEnabled: state.noiseGateEnabled,
        noiseGateThreshold: state.noiseGateThreshold,
        noiseSuppressionStrength: state.noiseSuppressionStrength,
        inputVolume: state.inputVolume,
        outputVolume: state.outputVolume,
        serverBackgroundEnabled: state.serverBackgroundEnabled,
        customCssEnabled: state.customCssEnabled,
      }),
    },
  ),
)
