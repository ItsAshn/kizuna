import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, SavedServer } from '@kizuna/shared'

interface ServerSession {
  serverId: string
  url: string
  token: string
  user: User
}

interface ServerState {
  servers: SavedServer[]
  activeSession: ServerSession | null
  addServer: (server: SavedServer) => void
  removeServer: (id: string) => void
  setActiveSession: (session: ServerSession | null) => void
  updateServerInfo: (id: string, updates: Partial<SavedServer>) => void
}

export const useServerStore = create<ServerState>()(
  persist(
    (set) => ({
      servers: [],
      activeSession: null,

      addServer: (server) =>
        set((state) => ({
          servers: [...state.servers.filter((s) => s.url !== server.url), server],
        })),

      removeServer: (id) =>
        set((state) => ({
          servers: state.servers.filter((s) => s.id !== id),
          activeSession: state.activeSession?.serverId === id ? null : state.activeSession,
        })),

      setActiveSession: (session) => set({ activeSession: session }),

      updateServerInfo: (id, updates) =>
        set((state) => ({
          servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),
    }),
    { name: 'kizuna-servers' },
  ),
)
