import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NotificationLevel = 'all' | 'mentions' | 'none';

interface NotificationSettings {
  level: NotificationLevel;
  suppressEveryone: boolean;
}

interface SettingsState {
  serverBackgroundEnabled: boolean;
  customCssEnabled: boolean;
  notificationSettings: Record<string, NotificationSettings>;
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
    (set) => ({
      serverBackgroundEnabled: true,
      customCssEnabled: true,
      notificationSettings: {},
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
      }),
    },
  ),
);
