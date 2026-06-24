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
  shareMediaActivity: boolean;
  shareAppActivity: boolean;
  customMediaActivity: string | null;
  customAppActivity: string | null;
  recentMediaActivities: string[];
  recentAppActivities: string[];
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
  setShareMediaActivity: (enabled: boolean) => void;
  setShareAppActivity: (enabled: boolean) => void;
  setCustomMediaActivity: (text: string | null) => void;
  setCustomAppActivity: (text: string | null) => void;
  addRecentMediaActivity: (name: string) => void;
  addRecentAppActivity: (name: string) => void;
  removeRecentMediaActivity: (name: string) => void;
  removeRecentAppActivity: (name: string) => void;
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
    (set, _get) => ({
      serverBackgroundEnabled: true,
      customCssEnabled: true,
      notificationSettings: {},
      recentChannels: [] as RecentChannel[],
      channelNotificationLevels: {},
      notificationSoundEnabled: true,
      shareMediaActivity: false,
      shareAppActivity: false,
      customMediaActivity: null,
      customAppActivity: null,
      recentMediaActivities: [] as string[],
      recentAppActivities: [] as string[],
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
      setShareMediaActivity: (shareMediaActivity) => set({ shareMediaActivity }),
      setShareAppActivity: (shareAppActivity) => set({ shareAppActivity }),
      setCustomMediaActivity: (customMediaActivity) => set({ customMediaActivity }),
      setCustomAppActivity: (customAppActivity) => set({ customAppActivity }),
      addRecentMediaActivity: (name) =>
        set((s) => ({
          recentMediaActivities: [name, ...s.recentMediaActivities.filter((n) => n !== name)].slice(0, 10),
        })),
      addRecentAppActivity: (name) =>
        set((s) => ({
          recentAppActivities: [name, ...s.recentAppActivities.filter((n) => n !== name)].slice(0, 10),
        })),
      removeRecentMediaActivity: (name) =>
        set((s) => ({
          recentMediaActivities: s.recentMediaActivities.filter((n) => n !== name),
        })),
      removeRecentAppActivity: (name) =>
        set((s) => ({
          recentAppActivities: s.recentAppActivities.filter((n) => n !== name),
        })),
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
      name: 'kizuna-settings-v2',
      partialize: (state) => ({
        serverBackgroundEnabled: state.serverBackgroundEnabled,
        customCssEnabled: state.customCssEnabled,
        notificationSettings: state.notificationSettings,
        recentChannels: state.recentChannels,
        channelNotificationLevels: state.channelNotificationLevels,
        notificationSoundEnabled: state.notificationSoundEnabled,
        shareMediaActivity: state.shareMediaActivity,
        shareAppActivity: state.shareAppActivity,
        customMediaActivity: state.customMediaActivity,
        customAppActivity: state.customAppActivity,
        recentMediaActivities: state.recentMediaActivities,
        recentAppActivities: state.recentAppActivities,
      }),
    },
  ),
);
