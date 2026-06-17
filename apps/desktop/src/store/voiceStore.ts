import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { VoicePeer, ConnectionQuality, UserStatus } from '@kizuna/shared';

export type VoiceInputMode = 'voice-activity' | 'push-to-talk';

interface VoiceState {
  activeVoiceChannelId: string | null;
  voicePeers: VoicePeer[];
  isMuted: boolean;
  isSpeaking: boolean;
  localConnectionQuality: ConnectionQuality | null;
  serverVoiceBitrateKbps: number;
  audioInputDeviceId: string | null;
  audioOutputDeviceId: string | null;
  voiceError: string | null;
  userStatuses: Record<string, UserStatus>;
  voiceInputMode: VoiceInputMode;
  pushToTalkKey: string;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  noiseGateEnabled: boolean;
  noiseGateThreshold: number;
  noiseSuppressionStrength: number;
  inputVolume: number;
  outputVolume: number;
  liveAudioLevel: number;
  voiceChannelUsers: Record<string, { userId: string; username: string }[]>;
  peerVolumes: Record<string, number>;

  setActiveVoiceChannel: (channelId: string | null) => void;
  setVoicePeers: (peers: VoicePeer[]) => void;
  addVoicePeer: (peer: VoicePeer) => void;
  removeVoicePeer: (peerId: string) => void;
  updateVoicePeer: (peerId: string, patch: Partial<VoicePeer>) => void;
  setIsMuted: (muted: boolean) => void;
  setIsSpeaking: (speaking: boolean) => void;
  setLocalConnectionQuality: (quality: ConnectionQuality | null) => void;
  setServerVoiceBitrateKbps: (kbps: number) => void;
  setAudioInputDeviceId: (id: string | null) => void;
  setAudioOutputDeviceId: (id: string | null) => void;
  setVoiceError: (error: string | null) => void;
  setUserStatus: (userId: string, status: UserStatus) => void;
  setUserStatuses: (statuses: Record<string, UserStatus>) => void;
  setVoiceChannelUsers: (users: Record<string, { userId: string; username: string }[]>) => void;
  addVoiceChannelUser: (channelId: string, user: { userId: string; username: string }) => void;
  removeVoiceChannelUser: (channelId: string, userId: string) => void;
  setPeerVolume: (peerId: string, volume: number) => void;
  setVoiceInputMode: (mode: VoiceInputMode) => void;
  setPushToTalkKey: (key: string) => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setNoiseGateEnabled: (enabled: boolean) => void;
  setNoiseGateThreshold: (threshold: number) => void;
  setNoiseSuppressionStrength: (strength: number) => void;
  setInputVolume: (volume: number) => void;
  setOutputVolume: (volume: number) => void;
  setLiveAudioLevel: (level: number) => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      activeVoiceChannelId: null,
      voicePeers: [],
      isMuted: false,
      isSpeaking: false,
      localConnectionQuality: null,
      serverVoiceBitrateKbps: 64,
      audioInputDeviceId: null,
      audioOutputDeviceId: null,
      voiceError: null,
      userStatuses: {},
      voiceInputMode: 'voice-activity',
      pushToTalkKey: 'AltLeft',
      noiseSuppression: true,
      autoGainControl: true,
      noiseGateEnabled: false,
      noiseGateThreshold: 30,
      noiseSuppressionStrength: 50,
      inputVolume: 100,
      outputVolume: 100,
      liveAudioLevel: 0,
      voiceChannelUsers: {},
      peerVolumes: {},

      setActiveVoiceChannel: (activeVoiceChannelId) => set({ activeVoiceChannelId }),
      setVoicePeers: (voicePeers) => set({ voicePeers }),
      addVoicePeer: (peer) =>
        set((s) => ({ voicePeers: [...s.voicePeers.filter((p) => p.id !== peer.id), peer] })),
      removeVoicePeer: (peerId) =>
        set((s) => ({ voicePeers: s.voicePeers.filter((p) => p.id !== peerId) })),
      updateVoicePeer: (peerId, patch) =>
        set((s) => ({
          voicePeers: s.voicePeers.map((p) => (p.id === peerId ? { ...p, ...patch } : p)),
        })),
      setIsMuted: (isMuted) => set({ isMuted }),
      setIsSpeaking: (isSpeaking) => set({ isSpeaking }),
      setLocalConnectionQuality: (localConnectionQuality) => set({ localConnectionQuality }),
      setServerVoiceBitrateKbps: (serverVoiceBitrateKbps) => set({ serverVoiceBitrateKbps }),
      setAudioInputDeviceId: (audioInputDeviceId) => set({ audioInputDeviceId }),
      setAudioOutputDeviceId: (audioOutputDeviceId) => set({ audioOutputDeviceId }),
      setVoiceError: (voiceError) => set({ voiceError }),
      setUserStatus: (userId, status) =>
        set((s) => ({ userStatuses: { ...s.userStatuses, [userId]: status } })),
      setUserStatuses: (statuses) =>
        set((s) => ({ userStatuses: { ...s.userStatuses, ...statuses } })),
      setVoiceChannelUsers: (voiceChannelUsers) => set({ voiceChannelUsers }),
      addVoiceChannelUser: (channelId, user) =>
        set((s) => {
          const current = s.voiceChannelUsers[channelId] || [];
          if (current.some((u) => u.userId === user.userId)) return s;
          return {
            voiceChannelUsers: { ...s.voiceChannelUsers, [channelId]: [...current, user] },
          };
        }),
      removeVoiceChannelUser: (channelId, userId) =>
        set((s) => {
          const current = s.voiceChannelUsers[channelId] || [];
          const filtered = current.filter((u) => u.userId !== userId);
          if (filtered.length === 0) {
            const next = { ...s.voiceChannelUsers };
            delete next[channelId];
            return { voiceChannelUsers: next };
          }
          return { voiceChannelUsers: { ...s.voiceChannelUsers, [channelId]: filtered } };
        }),
      setPeerVolume: (peerId, volume) =>
        set((s) => ({ peerVolumes: { ...s.peerVolumes, [peerId]: volume } })),
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
    }),
    {
      name: 'kizuna-voice-v1',
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
      }),
    },
  ),
);
