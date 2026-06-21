import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NotificationLevel = 'all' | 'mentions' | 'none';

interface NotificationSettings {
  level: NotificationLevel;
  suppressEveryone: boolean;
}

interface RecentChannel {
  id: string;
  type: 'text' | 'voice' | 'dm';
}

interface SettingsState {
  serverBackgroundEnabled: boolean;
  customCssEnabled: boolean;
  notificationSettings: Record<string, NotificationSettings>;
  recentChannels: RecentChannel[];
  channelNotificationLevels: Record<string, NotificationLevel>;
  notificationSoundEnabled: boolean;
  updateState: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  updateProgress: number;
  updateVersion: string | null;
  updateError: string | null;
  socketConnected: boolean;
  socketReconnecting: boolean;
  socketReconnectAttempts: number;

  setServerBackgroundEnabled: (enabled: boolean) => void;
  setCustomCssEnabled: (enabled: boolean) => void;
  setNotificationSettings: (serverId: string, settings: NotificationSettings) => void;
  pushRecentChannel: (channel: RecentChannel) => void;
  setChannelNotificationLevel: (channelId: string, level: NotificationLevel | null) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setUpdateState: (state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error') => void;
  setUpdateProgress: (progress: number) => void;
  setUpdateVersion: (version: string | null) => void;
  setUpdateError: (error: string | null) => void;
  setSocketConnected: (connected: boolean) => void;
  setSocketReconnecting: (reconnecting: boolean) => void;
  setSocketReconnectAttempts: (attempts: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      serverBackgroundEnabled: true,
      customCssEnabled: true,
      notificationSettings: {},
      recentChannels: [] as RecentChannel[],
      channelNotificationLevels: {},
      notificationSoundEnabled: true,
      updateState: 'idle',
      updateProgress: 0,
      updateVersion: null,
      updateError: null,
      socketConnected: true,
      socketReconnecting: false,
      socketReconnectAttempts: 0,

      setServerBackgroundEnabled: (serverBackgroundEnabled) => set({ serverBackgroundEnabled }),
      setCustomCssEnabled: (customCssEnabled) => set({ customCssEnabled }),
      setNotificationSettings: (serverId, settings) =>
        set((s) => ({
          notificationSettings: { ...s.notificationSettings, [serverId]: settings },
        })),
      pushRecentChannel: (channel) =>
        set((s) => {
          const filtered = s.recentChannels.filter((r) => !(r.id === channel.id && r.type === channel.type))
          return { recentChannels: [channel, ...filtered].slice(0, 10) }
        }),
      setChannelNotificationLevel: (channelId, level) =>
        set((s) => {
          if (level === null) {
            const next = { ...s.channelNotificationLevels }
            delete next[channelId]
            return { channelNotificationLevels: next }
          }
          return { channelNotificationLevels: { ...s.channelNotificationLevels, [channelId]: level } }
        }),
      setNotificationSoundEnabled: (notificationSoundEnabled) => set({ notificationSoundEnabled }),
      setUpdateState: (updateState) => set({ updateState }),
      setUpdateProgress: (updateProgress) => set({ updateProgress }),
      setUpdateVersion: (updateVersion) => set({ updateVersion }),
      setUpdateError: (updateError) => set({ updateError }),
      setSocketConnected: (socketConnected) =>
        set({ socketConnected, socketReconnecting: false, socketReconnectAttempts: 0 }),
      setSocketReconnecting: (socketReconnecting) =>
        set({ socketReconnecting, socketConnected: false }),
      setSocketReconnectAttempts: (socketReconnectAttempts) => set({ socketReconnectAttempts }),
    }),
    {
      name: 'kizuna-settings-v1',
      partialize: (state) => ({
        serverBackgroundEnabled: state.serverBackgroundEnabled,
        customCssEnabled: state.customCssEnabled,
        notificationSettings: state.notificationSettings,
        recentChannels: state.recentChannels,
        channelNotificationLevels: state.channelNotificationLevels,
        notificationSoundEnabled: state.notificationSoundEnabled,
      }),
    },
  ),
);
