import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, SavedServer } from '@kizuna/shared'
import { getMe } from '@kizuna/shared'

interface ServerSession {
  serverId: string
  url: string
  user: User
}

interface ServerState {
  servers: SavedServer[]
  sessions: Record<string, ServerSession>
  activeServerId: string | null
  activeSession: ServerSession | null
  addServer: (server: SavedServer) => void
  removeServer: (id: string) => void
  setActiveSession: (session: ServerSession | null) => void
  setActiveServer: (serverId: string | null) => void
  updateServerInfo: (id: string, updates: Partial<SavedServer>) => void
  refreshSessionUser: () => Promise<void>
}

export const useServerStore = create<ServerState>()(
  persist(
    (set, get) => ({
      servers: [],
      sessions: {},
      activeServerId: null,
      activeSession: null,

      addServer: (server) =>
        set((state) => ({
          servers: [...state.servers.filter((s) => s.url !== server.url), server],
        })),

      removeServer: (id) =>
        set((state) => {
          const { [id]: _, ...restSessions } = state.sessions
          return {
            servers: state.servers.filter((s) => s.id !== id),
            sessions: restSessions,
            activeServerId: state.activeServerId === id ? null : state.activeServerId,
            activeSession: state.activeServerId === id ? null : state.activeSession,
          }
        }),

      setActiveSession: (session) =>
        set((state) => {
          if (!session) return { activeSession: null, activeServerId: null }
          return {
            activeSession: session,
            activeServerId: session.serverId,
            sessions: { ...state.sessions, [session.serverId]: session },
          }
        }),

      setActiveServer: (serverId) =>
        set((state) => {
          if (!serverId) return { activeSession: null, activeServerId: null }
          const session = state.sessions[serverId]
          return {
            activeServerId: serverId,
            activeSession: session || null,
          }
        }),

      updateServerInfo: (id, updates) =>
        set((state) => ({
          servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),

      refreshSessionUser: async () => {
        const { activeSession } = get()
        if (!activeSession) return
        try {
          const user = await getMe(activeSession.url)
          set((state) => {
            const session = { ...activeSession, user }
            return {
              activeSession: session,
              sessions: { ...state.sessions, [session.serverId]: session },
            }
          })
        } catch {
          // token may be expired — auth middleware handles this elsewhere
        }
      },
    }),
    {
      name: 'kizuna-servers',
      partialize: (state) => ({
        servers: state.servers,
        sessions: state.sessions,
        activeServerId: state.activeServerId,
        activeSession: state.activeSession,
      }),
    },
  ),
)
